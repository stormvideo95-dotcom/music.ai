// Music AI for Mac — main process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron';

import { Pi, defaultDeviceName } from './pi.js';
import { getLyrics } from './lyrics.js';
import * as yt from './yt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YT_PARTITION = 'persist:youtube';

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
  ipcMain.handle('lyrics:get', safe((track) => getLyrics(track)));
  ipcMain.handle('likes:set', safe((track, liked) => setLike(track, liked)));
  ipcMain.handle('likes:all', safe(() => allLikes()));
  ipcMain.handle('likes:ids', safe(() => Object.keys(localLikes)));
  ipcMain.handle(
    'yt:stream',
    safe(async (id, refresh) => {
      if (refresh) yt.forgetStream(id, true);
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
    const headers = {};
    const range = request.headers.get('range');
    if (range) headers.Range = range;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await yt.resolveStream(id);
        const res = await net.fetch(s.url, { headers });
        if (res.status === 403 || res.status === 410) {
          yt.forgetStream(id, true);
          continue;
        }
        const out = new Headers();
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const v = res.headers.get(h);
          if (v) out.set(h, v);
        }
        if (!out.has('content-type') && s.mime) out.set('content-type', s.mime.split(';')[0]);
        return new Response(res.body, { status: res.status, headers: out });
      } catch (err) {
        console.error('[stream]', id, err);
        yt.forgetStream(id);
      }
    }
    return new Response('stream failed', { status: 502 });
  });
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
  });
}

app.whenReady().then(async () => {
  loadConfig();
  loadLikes();
  registerStreamProtocol();
  registerIpc();
  createWindow();
  pi.start();
  try {
    await startYt();
  } catch (err) {
    console.error('[yt] start failed', err);
  }
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
