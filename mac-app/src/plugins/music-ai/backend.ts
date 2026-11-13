// Music AI for Mac — talks to Storm's Pi (taste server + device sync).
// Runs in the main process so plain http:// to the Pi isn't blocked by the page.
import os from 'node:os';

import { dialog, net } from 'electron';

import { createBackend } from '@/utils';

import type { MusicAiConfig } from './index';
import type { BackendContext } from '@/types/contexts';

export type PiStatus = 'off' | 'online' | 'offline';

type CallOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
};

const baseUrl = (config: MusicAiConfig) =>
  (config.serverUrl ?? '').trim().replace(/\/+$/, '');

export const defaultDeviceName = () => {
  const user = os.userInfo().username || 'My';
  const pretty = user.charAt(0).toUpperCase() + user.slice(1);
  return `${pretty}'s Mac`;
};

export async function piCall<T = unknown>(
  config: MusicAiConfig,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; data: T | null } | null> {
  const base = baseUrl(config);
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.auth && config.token) headers['X-Device-Token'] = config.token;
    const res = await net.fetch(base + path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type BackendState = {
  config?: MusicAiConfig;
  ctx?: BackendContext<MusicAiConfig>;
  status: PiStatus;
  running: boolean;
  timers: NodeJS.Timeout[];
  setStatus(status: PiStatus): void;
  checkHealth(): Promise<void>;
  commandLoop(): Promise<void>;
  pairThisMac(): Promise<void>;
};

export const backend = createBackend<BackendState, MusicAiConfig>({
  status: 'off',
  running: false,
  timers: [],

  setStatus(status: PiStatus) {
    this.status = status;
    this.ctx?.ipc.send('music-ai:status', status);
  },

  async checkHealth() {
    const config = this.config;
    if (!config || !baseUrl(config)) {
      this.setStatus('off');
      return;
    }
    const res = await piCall<{ ok: boolean }>(config, '/health', {
      timeoutMs: 4000,
    });
    this.setStatus(res?.data?.ok ? 'online' : 'offline');
  },

  async commandLoop() {
    while (this.running) {
      const config = this.config;
      if (!config?.token || !baseUrl(config)) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const res = await piCall<{ commands: unknown[] }>(
        config,
        '/sync/commands?wait=20',
        { auth: true, timeoutMs: 30000 },
      );
      if (!res) {
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      if (res.status === 401) {
        await this.ctx?.setConfig({ token: '' });
        continue;
      }
      for (const command of res.data?.commands ?? []) {
        this.ctx?.ipc.send('music-ai:command', command);
      }
    }
  },

  async pairThisMac() {
    const config = this.config;
    const window = this.ctx?.window;
    if (!config || !baseUrl(config)) {
      await dialog.showMessageBox({
        type: 'warning',
        message: 'Set your Pi address first',
        detail:
          'Plugins → Music AI → Pi address… (for example http://umbrel.local:8765)',
      });
      return;
    }
    const name = config.deviceName || defaultDeviceName();
    const res = await piCall<{
      approved: boolean;
      token?: string;
      code?: string;
      pairId?: string;
    }>(config, '/pair/start', {
      method: 'POST',
      body: { name, type: 'mac' },
    });
    if (!res?.data) {
      await dialog.showMessageBox({
        type: 'error',
        message: "Can't reach your Pi",
        detail: 'Check the Pi address and that you are on the same network.',
      });
      return;
    }
    if (res.data.approved && res.data.token) {
      await this.ctx?.setConfig({ token: res.data.token, deviceName: name });
      await dialog.showMessageBox({ message: 'This Mac is paired!' });
      return;
    }
    const { code, pairId } = res.data;
    if (!code || !pairId) return;

    const box = window
      ? dialog.showMessageBox(window, {
          message: `Pairing code: ${code.slice(0, 3)} ${code.slice(3)}`,
          detail:
            'On your phone: Settings → Player and audio → Taste AI → Add a device, and type this code. This window closes by itself when it worked.',
          buttons: ['Cancel'],
        })
      : null;
    let cancelled = false;
    void box?.then(() => {
      cancelled = true;
    });

    for (let i = 0; i < 200 && !cancelled; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await piCall<{
        approved: boolean;
        token?: string;
        expired?: boolean;
      }>(config, `/pair/status?pairId=${encodeURIComponent(pairId)}`);
      if (status?.data?.approved && status.data.token) {
        await this.ctx?.setConfig({ token: status.data.token, deviceName: name });
        window?.webContents.send('music-ai:toast', `${name} is paired!`);
        if (!cancelled) {
          // Close the code window by focusing a new confirmation
          await dialog.showMessageBox({ message: 'This Mac is paired!' });
        }
        return;
      }
      if (status?.data?.expired) break;
    }
  },

  async start(ctx) {
    this.ctx = ctx;
    this.config = await ctx.getConfig();
    this.running = true;

    ctx.ipc.handle('music-ai:get-status', () => this.status);
    ctx.ipc.handle('music-ai:get-info', () => ({
      paired: Boolean(this.config?.token),
      hasServer: Boolean(this.config && baseUrl(this.config)),
      smartContinue: Boolean(this.config?.smartContinue),
    }));
    ctx.ipc.handle('music-ai:devices', async () => {
      if (!this.config?.token) return null;
      const res = await piCall<{ devices: unknown[] }>(
        this.config,
        '/sync/devices',
        { auth: true },
      );
      if (res?.status === 401) await ctx.setConfig({ token: '' });
      return res?.data ?? null;
    });
    ctx.ipc.handle('music-ai:state', async (state: unknown) => {
      if (!this.config?.token) return false;
      const res = await piCall(this.config, '/sync/state', {
        method: 'POST',
        auth: true,
        body: { state },
      });
      return res?.status === 200;
    });
    ctx.ipc.handle(
      'music-ai:command',
      async (target: string, command: unknown) => {
        if (!this.config?.token) return false;
        const res = await piCall(this.config, '/sync/command', {
          method: 'POST',
          auth: true,
          body: { target, command },
        });
        return res?.status === 200;
      },
    );
    ctx.ipc.handle('music-ai:event', async (event: unknown) => {
      if (!this.config) return false;
      const res = await piCall(this.config, '/events', {
        method: 'POST',
        body: { events: [event] },
      });
      this.setStatus(res ? 'online' : 'offline');
      return Boolean(res);
    });
    ctx.ipc.handle(
      'music-ai:rank',
      async (candidates: unknown[], recent: string[], count: number) => {
        if (!this.config) return null;
        const res = await piCall<{ ids: string[] }>(this.config, '/rank', {
          method: 'POST',
          body: { candidates, recent, count },
        });
        return res?.data?.ids ?? null;
      },
    );

    void this.checkHealth();
    this.timers.push(setInterval(() => void this.checkHealth(), 30_000));
    void this.commandLoop();
  },

  onConfigChange(newConfig) {
    this.config = newConfig;
    void this.checkHealth();
  },

  stop(ctx) {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const channel of [
      'music-ai:get-status',
      'music-ai:get-info',
      'music-ai:devices',
      'music-ai:state',
      'music-ai:command',
      'music-ai:event',
      'music-ai:rank',
    ]) {
      ctx.ipc.removeHandler(channel);
    }
  },
});
