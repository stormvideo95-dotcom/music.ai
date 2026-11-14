// Music AI for Mac — main process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain, net, protocol, session, shell, WebContentsView } from 'electron';

import { Pi, defaultDeviceName } from './pi.js';
import { PLAYER_PAGE_SCRIPT } from './player-page.js';
import { getLyrics } from './lyrics.js';
import * as yt from './yt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YT_PARTITION = 'persist:youtube';

// The hidden YouTube Music player has to start songs without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'musicai',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// ---------- config ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = {
  serverUrl: 'http://umbrel.local:8765',
  token: '',
  deviceName: '',
  smartContinue: true,
  volume: 0.8,
};
const loadConfig = () => {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    /* first run */
  }
};
const setConfig = async (patch) => {
  config = { ...config, ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  send('config', publicConfig());
};
const publicConfig = () => ({
  serverUrl: config.serverUrl,
  paired: Boolean(config.token),
  deviceName: config.deviceName || defaultDeviceName(),
  smartContinue: config.smartContinue,
  volume: config.volume,
  loggedIn: yt.isLoggedIn(),
});

let win = null;
const send = (channel, ...args) => win?.webContents.send(channel, ...args);

const pi = new Pi(
  () => config,
  setConfig,
  (status) => send('pi:status', status),
  (command) => send('pi:command', command),
);

// ---------- liked songs: saved on this Mac, on the Pi (shared with the phone) and on YouTube Music ----------
const likesPath = () => path.join(app.getPath('userData'), 'likes.json');
let localLikes = {};
const loadLikes = () => {
  try {
    localLikes = JSON.parse(fs.readFileSync(likesPath(), 'utf8'));
  } catch {
    localLikes = {};
  }
};
const saveLikes = () => fs.writeFileSync(likesPath(), JSON.stringify(localLikes));

async function setLike(track, liked) {
  if (liked) localLikes[track.id] = { ...track, likedAt: Date.now() };
  else delete localLikes[track.id];
  saveLikes();
  void pi.event({ type: liked ? 'like' : 'unlike', track: { ...track, thumbnail: track.thumb ?? null }, ts: Date.now() });
  if (yt.isLoggedIn()) {
    try {
      await yt.like(track.id, liked);
    } catch (err) {
      return { savedOnYouTube: false, error: String(err?.message ?? err) };
    }
    return { savedOnYouTube: true };
  }
  return { savedOnYouTube: false };
}

/** One liked-songs list: this Mac + the Pi (phone likes) + YouTube Music, newest first, no doubles. */
async function allLikes() {
  const out = new Map();
  const add = (t, source) => {
    if (!t?.id || out.has(t.id)) return;
    out.set(t.id, {
      kind: 'song',
      id: t.id,
      title: t.title ?? '',
      subtitle: t.subtitle ?? (t.artists ?? []).join(', '),
      artists: t.artists ?? [],
      album: t.album ?? null,
      duration: t.duration ?? 0,
      thumb: t.thumb ?? null,
      likedAt: t.likedAt ?? 0,
      source,
    });
  };
  const local = Object.values(localLikes).sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0));
  const [piLikes, ytLiked] = await Promise.all([
    pi.likes().catch(() => null),
    yt.isLoggedIn() ? yt.playlist('LM').catch(() => null) : null,
  ]);
  // A song unliked on another device (newer than our like) is removed here too.
  const unliked = new Set();
  for (const u of piLikes?.unliked ?? []) {
    const mine = localLikes[u.id];
    if (!mine || (mine.likedAt ?? 0) < u.at) unliked.add(u.id);
  }
  for (const id of unliked) {
    if (localLikes[id]) {
      delete localLikes[id];
      saveLikes();
    }
  }
  for (const t of [...local, ...(piLikes?.likes ?? [])].sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0))) {
    if (!unliked.has(t.id)) add(t, 'app');
  }
  for (const t of ytLiked?.items ?? []) add(t, 'youtube');
  return { items: [...out.values()].filter((t) => !unliked.has(t.id) || t.source === 'youtube'), youtubeCount: ytLiked?.items?.length ?? 0, piOnline: Boolean(piLikes) };
}

// ---------- YouTube login (cookies from a real Google sign-in window) ----------
async function cookieString() {
  const ses = session.fromPartition(YT_PARTITION);
  const cookies = await ses.cookies.get({ url: 'https://music.youtube.com' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function startYt() {
  const cookie = await cookieString();
  const hasAuth = /SAPISID=/.test(cookie);
  await yt.getYt(hasAuth ? cookie : '', path.join(app.getPath('userData'), 'yt-cache'));
  send('config', publicConfig());
}

function openLogin() {
  const login = new BrowserWindow({
    width: 480,
    height: 720,
    parent: win ?? undefined,
    modal: Boolean(win),
    title: 'Sign in to YouTube Music',
    webPreferences: { partition: YT_PARTITION },
  });
  login.loadURL(
    'https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F',
  );
  const check = async (_e, url) => {
    if (url.startsWith('https://music.youtube.com')) {
      const cookie = await cookieString();
      if (/SAPISID=/.test(cookie)) {
        login.close();
        await yt.getYt(cookie, path.join(app.getPath('userData'), 'yt-cache'));
        send('config', publicConfig());
        send('library:changed');
      }
    }
  };
  login.webContents.on('did-navigate', check);
  login.webContents.on('did-redirect-navigation', check);
}

async function logout() {
  const ses = session.fromPartition(YT_PARTITION);
  await ses.clearStorageData();
  await yt.getYt('', path.join(app.getPath('userData'), 'yt-cache'));
  send('config', publicConfig());
  send('library:changed');
}

// ---------- IPC ----------
const safe = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    console.error('[ipc]', err);
    return { ok: false, error: String(err?.message ?? err) };
  }
};

function registerIpc() {
  ipcMain.handle('yt:home', safe(() => yt.home()));
  ipcMain.handle('yt:search', safe((q) => yt.search(q)));
  ipcMain.handle('yt:suggest', safe((q) => yt.suggestions(q)));
  ipcMain.handle('yt:playlist', safe((id) => yt.playlist(id)));
  ipcMain.handle('yt:album', safe((id) => yt.album(id)));
  ipcMain.handle('yt:artist', safe((id) => yt.artist(id)));
  ipcMain.handle('yt:library', safe(() => yt.library()));
  ipcMain.handle('yt:upnext', safe((id) => yt.upNext(id)));
  ipcMain.handle('yt:like', safe((id, liked) => yt.like(id, liked)));
  ipcMain.handle('yt:diagnose', safe(() => yt.diagnose()));
  ipcMain.handle('yt:playback-error', safe((text) => yt.notePlaybackError(text)));
  ipcMain.handle('lyrics:get', safe((track) => getLyrics(track)));
  ipcMain.handle('likes:set', safe((track, liked) => setLike(track, liked)));
  ipcMain.handle('likes:all', safe(() => allLikes()));
  ipcMain.handle('likes:ids', safe(() => Object.keys(localLikes)));
  ipcMain.handle(
    'yt:stream',
    safe(async (id, refresh) => {
      // Only drop the cached link; a source is marked bad only when YouTube really refused it.
      if (refresh) yt.forgetStream(id);
      const s = await yt.resolveStream(id);
      return { src: `musicai://stream/${encodeURIComponent(id)}`, client: s.client, duration: s.duration };
    }),
  );
  ipcMain.handle('auth:login', safe(() => openLogin()));
  ipcMain.handle('auth:logout', safe(() => logout()));

  ipcMain.handle('config:get', safe(() => publicConfig()));
  ipcMain.handle('config:set', safe((patch) => {
    const allowed = {};
    for (const key of ['serverUrl', 'smartContinue', 'volume', 'deviceName']) {
      if (key in patch) allowed[key] = patch[key];
    }
    return setConfig(allowed).then(() => pi.checkHealth());
  }));
  ipcMain.handle('open:external', safe((url) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  }));

  ipcMain.handle('pi:status', safe(() => pi.status));
  ipcMain.handle('pi:health', safe(() => pi.checkHealth()));
  ipcMain.handle('pi:event', safe((event) => pi.event(event)));
  ipcMain.handle('pi:rank', safe((c, r, n) => pi.rank(c, r, n)));
  ipcMain.handle('pi:mixes', safe(() => pi.mixes()));
  ipcMain.handle('pi:devices', safe(() => pi.devices()));
  ipcMain.handle('pi:state', safe((state) => pi.sendState(state)));
  ipcMain.handle('pi:command', safe((target, command) => pi.command(target, command)));
  ipcMain.handle('pi:approve', safe((code) => pi.approve(code)));
  ipcMain.handle('pi:unpair', safe(() => pi.unpair()));

  let pairing = null;
  ipcMain.handle('pi:pair', safe(async () => {
    const res = await pi.pairStart();
    if (res.code) {
      const job = { cancelled: false };
      pairing = job;
      pi.pairWait(res.pairId, res.name, () => job.cancelled).then((ok) => {
        if (pairing === job) send('pi:paired', ok);
      });
    }
    return res;
  }));
  ipcMain.handle('pi:pair-cancel', safe(() => {
    if (pairing) pairing.cancelled = true;
    pairing = null;
  }));
}

// ---------- streaming protocol: musicai://stream/<videoId> ----------
function registerStreamProtocol() {
  protocol.handle('musicai', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'img') {
      // Album art proxied through the app so the UI can read its colors (dynamic color).
      try {
        const target = new URL(decodeURIComponent(url.pathname.slice(1)));
        if (target.protocol !== 'https:' || !/(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com)$/.test(target.hostname)) {
          return new Response('blocked', { status: 403 });
        }
        const res = await net.fetch(target.href);
        return new Response(res.body, {
          status: res.status,
          headers: {
            'content-type': res.headers.get('content-type') ?? 'image/jpeg',
            'access-control-allow-origin': '*',
          },
        });
      } catch {
        return new Response('bad image', { status: 400 });
      }
    }
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (url.hostname !== 'stream' || !id) return new Response('not found', { status: 404 });
    // YouTube refuses one big download ("bytes=0-") but allows small pieces, so the song is fetched in
    // 512 KB pieces. Each piece is downloaded completely right away (no connection is left waiting while
    // the player pauses reading), and a failed piece is retried instead of stopping the song.
    const CHUNK = 512 * 1024;
    const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? '');
    const start = m ? Number(m[1]) : 0;
    const reqEnd = m && m[2] !== '' ? Number(m[2]) : null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getPiece = async (from, to, expectTotal) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        let s;
        try {
          s = await yt.resolveStream(id);
          const res = await fetch(s.url, {
            headers: { Range: `bytes=${from}-${to}`, ...(s.ua ? { 'User-Agent': s.ua } : {}) },
          });
          if (res.status === 416) return { status: 416 };
          if (res.ok) {
            const total = Number(res.headers.get('content-range')?.split('/')[1]) || 0;
            if (expectTotal && total && total !== expectTotal) throw new Error('source changed');
            const buf = new Uint8Array(await res.arrayBuffer());
            return { buf, total, type: res.headers.get('content-type') ?? s.mime?.split(';')[0] ?? 'audio/webm' };
          }
          yt.notePlaybackError(`upstream ${res.status} via ${s.client} at byte ${from}`);
          // Second way of asking for the same piece (in the link itself instead of a header).
          const clen = Number(new URL(s.url).searchParams.get('clen')) || 0;
          const known = expectTotal || clen;
          if (known) {
            const alt = await fetch(`${s.url}&range=${from}-${Math.min(to, known - 1)}`, {
              headers: s.ua ? { 'User-Agent': s.ua } : {},
            });
            if (alt.ok) {
              const buf = new Uint8Array(await alt.arrayBuffer());
              if (buf.byteLength) {
                yt.notePlaybackError(`link-range worked via ${s.client}`);
                return { buf, total: known, type: alt.headers.get('content-type') ?? s.mime?.split(';')[0] ?? 'audio/webm' };
              }
            } else {
              yt.notePlaybackError(`link-range ${alt.status} via ${s.client} at byte ${from}`);
            }
          }
          // First a fresh link from the same source; if that is refused too, switch source.
          yt.forgetStream(id, attempt > 0);
        } catch (err) {
          const msg = String(err?.message ?? err).slice(0, 60);
          if (msg === 'source changed' || msg.includes('No playable stream') || msg.includes('SIGN_IN_REQUIRED')) throw err;
          yt.notePlaybackError(`network: ${msg} at byte ${from}`);
          await sleep(400 * (attempt + 1));
        }
      }
      throw new Error('piece failed');
    };
    try {
      const firstEnd = reqEnd === null ? start + CHUNK - 1 : Math.min(reqEnd, start + CHUNK - 1);
      const first = await getPiece(start, firstEnd, 0);
      if (first.status === 416) return new Response(null, { status: 416 });
      const total = first.total;
      if (!total) return new Response(first.buf, { status: 200, headers: { 'content-type': first.type } });
      const end = reqEnd === null ? total - 1 : Math.min(reqEnd, total - 1);
      let pos = start;
      let pending = first.buf;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            if (!pending) {
              if (pos > end) {
                controller.close();
                return;
              }
              const next = await getPiece(pos, Math.min(pos + CHUNK - 1, end), total);
              if (!next.buf?.byteLength) throw new Error('empty piece');
              pending = next.buf;
            }
            pos += pending.byteLength;
            controller.enqueue(pending);
            pending = null;
            if (pos > end) controller.close();
          } catch (err) {
            yt.notePlaybackError(`stopped at byte ${pos}: ${String(err?.message ?? err).slice(0, 60)}`);
            controller.error(err);
          }
        },
      });
      return new Response(body, {
        status: m ? 206 : 200,
        headers: {
          'content-type': first.type,
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
          ...(m ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
        },
      });
    } catch (err) {
      console.error('[stream]', id, err);
      yt.notePlaybackError(`stream error: ${String(err?.message ?? err).slice(0, 80)}`);
    }
    return new Response('stream failed', { status: 502 });
  });
}

// ---------- hidden player: YouTube Music's own player, invisible, driven by the app ----------
let playerView = null;
let hpWant = { id: null, pos: 0, playing: true, volume: 0.8 };
let hpWatchdog = null;
let hpStarted = false;

function setupPlayerSession() {
  const ses = session.fromPartition(YT_PARTITION);
  // Plain Chrome identity: Google treats unknown browsers worse.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|music-ai-mac|Music AI)\/\S+/gi, ''));
  ses.webRequest.onBeforeRequest(
    {
      urls: [
        '*://*.doubleclick.net/*',
        '*://*.googlesyndication.com/*',
        '*://*.googleadservices.com/*',
        '*://*.youtube.com/pagead/*',
        '*://*.youtube.com/api/stats/ads*',
        '*://*.youtube.com/ptracking*',
        '*://*.youtube.com/youtubei/v1/player/ad_break*',
      ],
    },
    (_details, callback) => callback({ cancel: true }),
  );
  // Skip the EU cookie-consent wall when not signed in.
  ses.cookies
    .set({
      url: 'https://www.youtube.com',
      name: 'SOCS',
      value: 'CAI',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
    })
    .catch(() => {});
}

// The player lives inside the main window as an (out of sight) child view, so to YouTube it is a
// normal visible page.
function ensurePlayerView() {
  if (playerView && !playerView.webContents.isDestroyed()) return playerView;
  if (!win) return null;
  playerView = new WebContentsView({
    webPreferences: { partition: YT_PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.contentView.addChildView(playerView);
  const place = () => {
    if (!win || !playerView) return;
    const [, h] = win.getContentSize();
    playerView.setBounds({ x: 0, y: h + 50, width: 960, height: 640 });
  };
  place();
  win.on('resize', place);
  const wc = playerView.webContents;
  wc.setAudioMuted(false);
  wc.on('dom-ready', async () => {
    await wc.executeJavaScript(PLAYER_PAGE_SCRIPT).catch(() => {});
    const w = hpWant;
    if (w.id) {
      await wc
        .executeJavaScript(`window.__musicai.adopt(${JSON.stringify(w.id)}, ${Number(w.pos) || 0}, ${Boolean(w.playing)}, ${Number(w.volume)})`)
        .catch(() => {});
    }
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      yt.notePlaybackError(`player page failed: ${desc}`);
      send('hp:event', 'error');
    }
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  return playerView;
}

const hpRun = (code) =>
  playerView && !playerView.webContents.isDestroyed()
    ? playerView.webContents.executeJavaScript(code).catch(() => null)
    : Promise.resolve(null);

async function hpLoad(id, pos = 0) {
  const view = ensurePlayerView();
  if (!view) return false;
  const wc = view.webContents;
  hpWant = { ...hpWant, id, pos, playing: true };
  hpStarted = false;
  clearTimeout(hpWatchdog);
  hpWatchdog = setTimeout(() => {
    if (!hpStarted && hpWant.id === id) {
      yt.notePlaybackError(`player did not start ${id} within 20s (page: ${wc.getURL().slice(0, 80)})`);
      send('hp:event', 'error');
    }
  }, 20_000);
  const onPage = /^https:\/\/music\.youtube\.com\//.test(wc.getURL());
  const switched = onPage
    ? await hpRun(`window.__musicai ? window.__musicai.load(${JSON.stringify(id)}, ${Number(pos) || 0}, ${Number(hpWant.volume)}) : false`)
    : false;
  if (!switched) await wc.loadURL(`https://music.youtube.com/watch?v=${encodeURIComponent(id)}`).catch(() => {});
  return true;
}

function registerHiddenPlayerIpc() {
  // Ask the player page 4 times a second what it is doing.
  setInterval(async () => {
    if (!hpWant.id) return;
    const res = await hpRun('window.__musicai ? window.__musicai.poll() : null');
    if (!res) return;
    for (const name of res.events ?? []) {
      if (name.startsWith('stall:')) yt.notePlaybackError(`player stalled ${name.slice(6)}`);
      else send('hp:event', name);
    }
    const state = res.state;
    if (state) {
      if (state.id === hpWant.id && state.t > 0.2) {
        hpStarted = true;
        clearTimeout(hpWatchdog);
      }
      send('hp:state', state);
    }
  }, 250);
  ipcMain.handle('hp:load', safe((id, pos) => hpLoad(String(id), Number(pos) || 0)));
  ipcMain.handle(
    'hp:cmd',
    safe((name, value) => {
      if (name === 'play') {
        hpWant.playing = true;
        return hpRun('window.__musicai && window.__musicai.play()');
      }
      if (name === 'pause') {
        hpWant.playing = false;
        return hpRun('window.__musicai && window.__musicai.pause()');
      }
      if (name === 'seek') return hpRun(`window.__musicai && window.__musicai.seek(${Number(value) || 0})`);
      if (name === 'volume') {
        hpWant.volume = Math.max(0, Math.min(1, Number(value) || 0));
        return hpRun(`window.__musicai && window.__musicai.volume(${hpWant.volume})`);
      }
    }),
  );
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Music AI',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
    try {
      playerView?.webContents.close();
    } catch {
      /* already gone */
    }
    playerView = null;
    hpWant = { ...hpWant, id: null, playing: false };
  });
}

app.whenReady().then(async () => {
  loadConfig();
  loadLikes();
  registerStreamProtocol();
  registerIpc();
  setupPlayerSession();
  registerHiddenPlayerIpc();
  hpWant.volume = config.volume ?? 0.8;
  createWindow();
  pi.start();
  try {
    await startYt();
  } catch (err) {
    console.error('[yt] start failed', err);
  }
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
