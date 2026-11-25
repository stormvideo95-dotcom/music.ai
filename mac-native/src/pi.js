// Talks to Storm's Pi: taste AI (events, rank, mixes) and device sync (pairing, now playing, Play on).
import os from 'node:os';

export const defaultDeviceName = () => {
  const user = os.userInfo().username || 'My';
  return `${user.charAt(0).toUpperCase()}${user.slice(1)}'s Mac`;
};

export class Pi {
  constructor(getConfig, setConfig, onStatus, onCommand) {
    this.getConfig = getConfig;
    this.setConfig = setConfig;
    this.onStatus = onStatus;
    this.onCommand = onCommand;
    this.status = 'off';
    this.running = false;
    this.current = '';
    this.where = null;
    this.lastResolveAt = 0;
  }

  // Home address first, then the away one (for example Tailscale).
  urls() {
    const clean = (u) => (u || '').trim().replace(/\/+$/, '');
    const { serverUrl, awayUrl } = this.getConfig();
    const list = [
      { url: clean(serverUrl), where: 'home' },
      { url: clean(awayUrl), where: 'away' },
    ].filter((c) => c.url);
    return list.filter((c, i) => list.findIndex((o) => o.url === c.url) === i);
  }

  base() {
    const urls = this.urls();
    return urls.find((c) => c.url === this.current)?.url ?? urls[0]?.url ?? '';
  }

  async call(path, opts = {}) {
    const res = await this.callAt(this.base(), path, opts);
    // The address in use stopped answering: look for the other one (at most every 15 s).
    if (!res && this.urls().length > 1 && Date.now() - this.lastResolveAt > 15_000) void this.checkHealth();
    return res;
  }

  async callAt(base, path, { method = 'GET', body, auth = false, timeoutMs = 8000 } = {}) {
    if (!base) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = this.getConfig().token;
      if (auth && token) headers['X-Device-Token'] = token;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.status === 401 && auth) await this.setConfig({ token: '' });
      return { status: res.status, data };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  setStatus(status) {
    if (status !== this.status) {
      this.status = status;
      this.onStatus(status);
    }
  }

  async checkHealth() {
    const urls = this.urls();
    if (!urls.length) return this.setStatus('off');
    this.lastResolveAt = Date.now();
    for (const { url, where } of urls) {
      const quick = urls.length > 1 && where === 'home';
      const res = await this.callAt(url, '/health', { timeoutMs: quick ? 2500 : 4000 });
      if (res?.data?.ok) {
        const switched = this.where !== where;
        this.current = url;
        this.where = where;
        this.setStatus('online');
        if (switched) this.onStatus(this.status);
        return res.data;
      }
    }
    this.where = null;
    this.setStatus('offline');
    return null;
  }

  start() {
    this.running = true;
    void this.checkHealth();
    this.healthTimer = setInterval(() => void this.checkHealth(), 30_000);
    void this.commandLoop();
  }

  stop() {
    this.running = false;
    clearInterval(this.healthTimer);
  }

  async commandLoop() {
    while (this.running) {
      if (!this.getConfig().token || !this.base()) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const res = await this.call('/sync/commands?wait=20', { auth: true, timeoutMs: 30_000 });
      if (!res || res.status !== 200) {
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      for (const command of res.data?.commands ?? []) this.onCommand(command);
    }
  }

  // ----- taste AI -----
  async event(event) {
    const res = await this.call('/events', { method: 'POST', body: { events: [event] } });
    this.setStatus(res ? 'online' : this.base() ? 'offline' : 'off');
    return Boolean(res);
  }

  async rank(candidates, recent, count) {
    const res = await this.call('/rank', { method: 'POST', body: { candidates, recent, count } });
    return res?.data?.ids ?? null;
  }

  async likes() {
    const res = await this.call('/likes', { timeoutMs: 5000 });
    return res?.data?.likes ? res.data : null;
  }

  async mixes() {
    await this.call('/train', { method: 'POST', body: {}, timeoutMs: 60_000 });
    const res = await this.call('/mixes');
    return res?.data ?? null;
  }

  // ----- devices -----
  async devices() {
    if (!this.getConfig().token) return null;
    const res = await this.call('/sync/devices', { auth: true });
    return res?.data ?? null;
  }

  async sendState(state) {
    if (!this.getConfig().token) return false;
    const res = await this.call('/sync/state', { method: 'POST', auth: true, body: { state } });
    return res?.status === 200;
  }

  async command(target, command) {
    const res = await this.call('/sync/command', { method: 'POST', auth: true, body: { target, command } });
    return res?.status === 200;
  }

  async pairStart() {
    const name = this.getConfig().deviceName || defaultDeviceName();
    const res = await this.call('/pair/start', { method: 'POST', body: { name, type: 'mac' } });
    if (!res?.data) return { error: 'offline' };
    if (res.data.approved && res.data.token) {
      await this.setConfig({ token: res.data.token, deviceName: name });
      return { paired: true };
    }
    return { code: res.data.code, pairId: res.data.pairId, name };
  }

  async pairWait(pairId, name, isCancelled) {
    for (let i = 0; i < 200 && !isCancelled(); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await this.call(`/pair/status?pairId=${encodeURIComponent(pairId)}`);
      if (res?.data?.approved && res.data.token) {
        await this.setConfig({ token: res.data.token, deviceName: name });
        return true;
      }
      if (res?.data?.expired) return false;
    }
    return false;
  }

  async approve(code) {
    const res = await this.call('/pair/approve', {
      method: 'POST',
      auth: true,
      body: { code: String(code).replace(/\s/g, '') },
    });
    return res ? (res.status === 200 ? 'paired' : 'wrong') : 'offline';
  }

  async unpair() {
    await this.call('/sync/unpair', { method: 'POST', auth: true, body: {} });
    await this.setConfig({ token: '' });
  }
}
