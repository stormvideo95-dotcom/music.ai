// Music AI for Mac — UI, player, and Pi features.
const api = window.musicai;
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const audio = $('#audio');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const thumbOf = (item) => item?.thumb || (item?.id ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg` : '');

const ms = (name, fill = false) => `<span class="ms${fill ? ' fill' : ''}">${name}</span>`;
const ICON_PLAY = ms('play_arrow', true);
const ICON_SHUFFLE = ms('shuffle');
const ICON_LAPTOP = ms('laptop_mac');
const ICON_PHONE = ms('smartphone');

import {
  Hct,
  SchemeTonalSpot,
  MaterialDynamicColors,
  hexFromArgb,
  argbFromRgb,
  QuantizerCelebi,
  Score,
} from './vendor/mcu.js';

let config = {};
let piStatus = 'off';

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ======================================================================
// Player
// ======================================================================
const player = {
  queue: [],
  index: -1,
  repeat: false,
  liked: new Set(),
  recent: [],
  started: 0,
  extending: false,
  loadToken: 0,

  get current() {
    return this.queue[this.index] ?? null;
  },

  async playList(items, start = 0, positionSec = 0) {
    const songs = items.filter((i) => i && i.id && (i.kind === 'song' || !i.kind));
    if (!songs.length) return;
    this.queue = songs.map((s) => ({ ...s }));
    await this.load(Math.max(0, Math.min(start, songs.length - 1)), positionSec);
  },

  async load(index, positionSec = 0) {
    this.logListen();
    this.index = index;
    const track = this.current;
    if (!track) return;
    const token = ++this.loadToken;
    renderNowPlaying();
    renderQueue();
    try {
      const stream = await api.invoke('yt:stream', track.id, false);
      if (token !== this.loadToken) return;
      if (!track.duration && stream.duration) track.duration = stream.duration;
      audio.src = stream.src;
      audio.currentTime = 0;
      if (positionSec > 1) {
        audio.addEventListener('loadedmetadata', () => (audio.currentTime = positionSec), { once: true });
      }
      await audio.play();
    } catch (err) {
      if (token !== this.loadToken) return;
      console.error(err);
      if (String(err?.message).includes('SIGN_IN_REQUIRED')) {
        audio.pause();
        toast('YouTube wants you to sign in first');
        if (!config.loggedIn) go('settings');
        return;
      }
      this.failStreak = (this.failStreak ?? 0) + 1;
      if (this.failStreak >= 3) {
        this.failStreak = 0;
        toast("Can't play songs right now. Check your internet or sign in.");
        return;
      }
      toast(`Can't play "${track.title}" — skipping`);
      setTimeout(() => this.next(true), 800);
      return;
    }
    this.started = Date.now();
    this.failStreak = 0;
    this.recent = [...this.recent.filter((id) => id !== track.id), track.id].slice(-50);
    updateMediaSession();
    void sendState();
    void this.maybeExtend();
  },

  logListen() {
    const prev = this.current;
    if (!prev || !this.started) return;
    const listened = Date.now() - this.started;
    const durationMs = (prev.duration || audio.duration || 0) * 1000;
    const type = durationMs > 0 && (audio.ended || listened >= durationMs * 0.8) ? 'complete' : 'skip';
    if (listened > 1500) {
      void api.invoke('pi:event', {
        type,
        track: trackForPi(prev),
        ts: Date.now(),
        listenedMs: listened,
      }).catch(() => {});
    }
    this.started = 0;
  },

  toggle() {
    if (!this.current) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  },

  next(auto = false) {
    if (this.repeat && auto && this.current) return this.load(this.index);
    if (this.index + 1 < this.queue.length) return this.load(this.index + 1);
    if (auto) audio.pause();
  },

  prev() {
    if (audio.currentTime > 4 || this.index === 0) {
      audio.currentTime = 0;
      return;
    }
    if (this.index > 0) void this.load(this.index - 1);
  },

  shuffleRest() {
    if (this.queue.length < 3) return;
    const head = this.queue.slice(0, this.index + 1);
    const rest = this.queue.slice(this.index + 1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.queue = [...head, ...rest];
    renderQueue();
    toast('Shuffled what comes next');
  },

  async toggleLike() {
    const t = this.current;
    if (!t) return;
    const liked = !this.liked.has(t.id);
    if (liked) this.liked.add(t.id);
    else this.liked.delete(t.id);
    renderLike();
    void api.invoke('pi:event', { type: liked ? 'like' : 'unlike', track: trackForPi(t), ts: Date.now() }).catch(() => {});
    if (config.loggedIn) {
      api.invoke('yt:like', t.id, liked).catch((err) => toast(`YouTube Music didn't save that like: ${err.message}`));
    } else {
      toast('Sign in (Settings) to save likes to YouTube Music');
    }
  },

  /** Keep the music going: when 2 songs are left, add songs (ranked by the Pi when Smart continue is on). */
  async maybeExtend() {
    if (this.extending || !this.current) return;
    if (this.queue.length - this.index > 2) return;
    this.extending = true;
    try {
      const seed = this.current;
      const inQueue = new Set(this.queue.map((t) => t.id));
      const radio = (await api.invoke('yt:upnext', seed.id)).filter(
        (t) => !inQueue.has(t.id) && !this.recent.includes(t.id),
      );
      if (!radio.length) return;
      let picked = radio.slice(0, 10);
      if (config.smartContinue) {
        const ids = await api
          .invoke('pi:rank', radio.map(trackForPi), this.recent.slice(-20), 10)
          .catch(() => null);
        if (ids?.length) {
          const byId = new Map(radio.map((t) => [t.id, t]));
          picked = ids.map((id) => byId.get(id)).filter(Boolean);
        }
      }
      this.queue.push(...picked);
      renderQueue();
    } catch (err) {
      console.warn('extend failed', err);
    } finally {
      this.extending = false;
    }
  },
};

const trackForPi = (t) => ({
  id: t.id,
  title: t.title,
  artists: t.artists?.length ? t.artists : [t.subtitle].filter(Boolean),
  album: t.album ?? null,
  duration: Math.round(t.duration || 0),
  thumbnail: thumbOf(t),
});

audio.addEventListener('ended', () => player.next(true));
audio.addEventListener('play', renderPlayState);
audio.addEventListener('pause', renderPlayState);
audio.addEventListener('error', async () => {
  const t = player.current;
  if (!t || !audio.src) return;
  // Stream URL may have expired: get a fresh one once.
  if (!audio.dataset.retried) {
    audio.dataset.retried = '1';
    const pos = audio.currentTime;
    try {
      const s = await api.invoke('yt:stream', t.id, true);
      audio.src = s.src;
      audio.currentTime = pos;
      await audio.play();
      return;
    } catch {
      /* fall through */
    }
  }
  toast(`Can't play "${t.title}"`);
  player.next(true);
});
audio.addEventListener('loadstart', () => delete audio.dataset.retried);

const bar = $('#p-bar');
let seeking = false;
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || player.current?.duration || 0;
  $('#p-time').textContent = fmt(audio.currentTime);
  $('#p-dur').textContent = fmt(d);
  if (!seeking && d) {
    bar.value = Math.round((audio.currentTime / d) * 1000);
    bar.style.setProperty('--fill', `${bar.value / 10}%`);
  }
  $('#np-clip-rect').setAttribute('width', d ? String((audio.currentTime / d) * 600) : '0');
  $('#np-time').textContent = fmt(audio.currentTime);
  $('#np-dur').textContent = fmt(d);
});
bar.addEventListener('input', () => {
  seeking = true;
  bar.style.setProperty('--fill', `${bar.value / 10}%`);
});
bar.addEventListener('change', () => {
  const d = audio.duration || 0;
  if (d) audio.currentTime = (bar.value / 1000) * d;
  seeking = false;
});

const vol = $('#p-vol');
vol.addEventListener('input', () => {
  audio.volume = vol.value / 100;
  vol.style.setProperty('--fill', `${vol.value}%`);
});
vol.addEventListener('change', () => void api.invoke('config:set', { volume: audio.volume }));

$('#p-play').onclick = () => player.toggle();
$('#p-next').onclick = () => player.next();
$('#p-prev').onclick = () => player.prev();
$('#p-shuffle').onclick = () => player.shuffleRest();
$('#p-repeat').onclick = () => {
  player.repeat = !player.repeat;
  $('#p-repeat').classList.toggle('on', player.repeat);
};
$('#p-like').onclick = () => player.toggleLike();
$('#p-queue').onclick = () => $('#queue-panel').classList.toggle('hidden');
$('#queue-close').onclick = () => $('#queue-panel').classList.add('hidden');
$('#p-art').onclick = () => {
  $('#nowplaying').classList.remove('hidden');
  drawWave();
  startWave();
};
$('#np-close').onclick = () => $('#nowplaying').classList.add('hidden');

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    player.toggle();
  } else if (e.code === 'ArrowRight' && e.metaKey) player.next();
  else if (e.code === 'ArrowLeft' && e.metaKey) player.prev();
});

function renderPlayState() {
  $('#p-play-icon').textContent = audio.paused ? 'play_arrow' : 'pause';
  $('#p-play').classList.toggle('playing', !audio.paused);
  $('#np-art-wrap').classList.toggle('playing', !audio.paused);
  if (!audio.paused) startWave();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function renderLike() {
  const liked = player.current && player.liked.has(player.current.id);
  $('#p-like').innerHTML = ms('favorite', Boolean(liked));
  $('#p-like').classList.toggle('on', Boolean(liked));
}

function renderNowPlaying() {
  const t = player.current;
  if (!t) return;
  const art = thumbOf(t);
  $('#p-art').src = art;
  $('#p-title').textContent = t.title;
  $('#p-artist').textContent = t.subtitle || t.artists?.join(', ') || '';
  $('#np-art').src = art;
  $('#np-bg').style.backgroundImage = `url("${art}")`;
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = t.subtitle || '';
  document.title = `${t.title} · Music AI`;
  renderLike();
  applyAccent(art);
  document.querySelectorAll('.track[data-id]').forEach((row) => row.classList.toggle('playing', row.dataset.id === t.id));
}

function renderQueue() {
  const list = $('#queue-list');
  const upcoming = player.queue.slice(player.index, player.index + 60);
  list.innerHTML = upcoming
    .map(
      (t, i) => `<div class="track ${i === 0 ? 'playing' : ''}" data-qi="${player.index + i}">
        <img src="${esc(thumbOf(t))}" alt="" loading="lazy" />
        <div><div class="ellipsis">${esc(t.title)}</div><div class="ellipsis muted" style="font-size:12px">${esc(t.subtitle)}</div></div>
      </div>`,
    )
    .join('');
  list.querySelectorAll('[data-qi]').forEach((row) => (row.onclick = () => player.load(Number(row.dataset.qi))));
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !player.current) return;
  const t = player.current;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.subtitle || '',
    album: t.album || '',
    artwork: [{ src: thumbOf(t), sizes: '544x544' }],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
  navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
}

// Dynamic color (Material 3): build a full color scheme from the album art.
const ROLES = {
  primary: 'primary',
  onPrimary: 'on-primary',
  primaryContainer: 'primary-container',
  onPrimaryContainer: 'on-primary-container',
  secondaryContainer: 'secondary-container',
  onSecondaryContainer: 'on-secondary-container',
  tertiary: 'tertiary',
  tertiaryContainer: 'tertiary-container',
  onTertiaryContainer: 'on-tertiary-container',
  surface: 'surface',
  surfaceContainerLowest: 'surface-container-lowest',
  surfaceContainerLow: 'surface-container-low',
  surfaceContainer: 'surface-container',
  surfaceContainerHigh: 'surface-container-high',
  surfaceContainerHighest: 'surface-container-highest',
  onSurface: 'on-surface',
  onSurfaceVariant: 'on-surface-variant',
  outline: 'outline',
  outlineVariant: 'outline-variant',
  inverseSurface: 'inverse-surface',
  inverseOnSurface: 'inverse-on-surface',
};

function applyScheme(sourceArgb) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(sourceArgb), true, 0);
  const root = document.documentElement.style;
  for (const [role, cssName] of Object.entries(ROLES)) {
    const color = MaterialDynamicColors[role];
    if (color) root.setProperty(`--md-${cssName}`, hexFromArgb(color.getArgb(scheme)));
  }
}

function applyAccent(src) {
  if (!src) return;
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      const pixels = [];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250) pixels.push(argbFromRgb(d[i], d[i + 1], d[i + 2]));
      const ranked = Score.score(QuantizerCelebi.quantize(pixels, 128));
      if (ranked.length) applyScheme(ranked[0]);
    } catch (err) {
      console.warn('dynamic color failed', err);
    }
  };
  // Loaded through the app so the canvas may read it.
  img.src = `musicai://img/${encodeURIComponent(src)}`;
}

// Expressive "cookie" shapes for the hero artwork and AI mix covers.
function cookiePath(points, depth) {
  const steps = 360;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = 0.5 - depth + depth * Math.cos(points * a);
    const x = 0.5 + r * Math.cos(a);
    const y = 0.5 + r * Math.sin(a);
    d += `${i ? 'L' : 'M'}${x.toFixed(4)},${y.toFixed(4)}`;
  }
  return `${d}Z`;
}
$('#cookie-path').setAttribute('d', cookiePath(9, 0.035));
$('#cookie-big-path').setAttribute('d', cookiePath(12, 0.022));

// Wavy progress in Now Playing (moves while playing, flat when paused).
let wavePhase = 0;
let waveRunning = false;
function drawWave() {
  const amp = audio.paused ? 0 : 4;
  let d = '';
  for (let x = 0; x <= 600; x += 6) {
    const y = 12 + amp * Math.sin((x / 600) * Math.PI * 2 * 14 + wavePhase);
    d += `${x ? 'L' : 'M'}${x},${y.toFixed(2)}`;
  }
  $('#np-wave-path').setAttribute('d', d);
}
function startWave() {
  if (waveRunning) return;
  waveRunning = true;
  const tick = () => {
    if ($('#nowplaying').classList.contains('hidden') || audio.paused) {
      waveRunning = false;
      drawWave();
      return;
    }
    wavePhase -= 0.08;
    drawWave();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
$('#np-wave').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const d = audio.duration || 0;
  if (d) audio.currentTime = ((e.clientX - rect.left) / rect.width) * d;
});

// ======================================================================
// Pi: status, state heartbeat, commands, Play on
// ======================================================================
function currentState() {
  const t = player.current;
  return {
    track: t ? trackForPi(t) : null,
    positionMs: Math.round(audio.currentTime * 1000),
    playing: !audio.paused,
    queue: player.queue.slice(player.index + 1, player.index + 26).map(trackForPi),
    updatedAt: Date.now(),
  };
}

async function sendState() {
  if (!config.paired) return;
  await api.invoke('pi:state', currentState()).catch(() => {});
}

let beat = 0;
setInterval(() => {
  beat++;
  if (!audio.paused || beat % 3 === 0) void sendState();
}, 10_000);

const fromPi = (t) => ({
  kind: 'song',
  id: t.id,
  title: t.title,
  subtitle: (t.artists ?? []).join(', '),
  artists: t.artists ?? [],
  album: t.album ?? null,
  duration: t.duration ?? 0,
  thumb: t.thumbnail ?? null,
});

api.on('pi:command', (command) => {
  if (command.action === 'play' && command.track) {
    const tracks = [command.track, ...(command.queue ?? [])].map(fromPi);
    void player.playList(tracks, 0, (command.positionMs ?? 0) / 1000);
    if (command.from) toast(`Moved here from ${command.from}`);
  } else if (command.action === 'pause') {
    audio.pause();
  }
});

function renderPiStatus() {
  for (const el of [$('#pi-dot'), $('#p-devices-dot')]) el.dataset.status = piStatus;
  $('#pi-label').textContent =
    piStatus === 'online' ? 'Pi connected' : piStatus === 'offline' ? 'Pi offline' : 'Pi not set up';
}

api.on('pi:status', (s) => {
  piStatus = s;
  renderPiStatus();
  if (route.name === 'settings') renderSettings();
});

const popup = $('#devices-popup');
$('#p-devices').onclick = (e) => {
  e.stopPropagation();
  if (!popup.classList.contains('hidden')) return popup.classList.add('hidden');
  popup.classList.remove('hidden');
  void renderDevices();
};
popup.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => popup.classList.add('hidden'));

async function renderDevices() {
  popup.innerHTML = '<div class="title">Play on</div><div class="loader"></div>';
  const data = config.paired ? await api.invoke('pi:devices').catch(() => null) : null;
  const others = (data?.devices ?? []).filter((d) => !d.me);
  let html = `<div class="title">Play on</div>
    <div class="device selected">${ICON_LAPTOP}<div class="info"><div class="name">This Mac</div><div class="sub">${audio.paused ? 'Ready' : 'Playing here'}</div></div></div>`;
  if (!config.paired) html += `<div class="hint">Pair this Mac in Settings to see your phone here.</div>`;
  else if (!others.length) html += `<div class="hint">No other devices paired yet.</div>`;
  for (const d of others) {
    const t = d.state?.track;
    const sub = !d.online ? 'Offline' : t ? `${d.state.playing ? 'Playing' : 'Paused'}: ${esc(t.title)}` : 'Online';
    html += `<div class="device ${d.online ? '' : 'disabled'}" data-device="${esc(d.id)}">
      ${d.type === 'mac' || d.type === 'desktop' ? ICON_LAPTOP : ICON_PHONE}
      <div class="info"><div class="name ellipsis">${esc(d.name)}</div><div class="sub ellipsis">${sub}</div></div>
      ${t ? `<button class="continue" data-continue="${esc(d.id)}">Continue here</button>` : ''}
    </div>`;
  }
  const statusText = piStatus === 'online' ? 'Pi connected' : piStatus === 'offline' ? 'Pi offline' : 'Pi not set up';
  html += `<div class="footer"><span class="dot" data-status="${piStatus}"></span>${statusText}</div>`;
  popup.innerHTML = html;

  popup.querySelectorAll('[data-device]').forEach((row) => {
    row.onclick = async (e) => {
      if (e.target.closest('[data-continue]')) return;
      const d = others.find((x) => x.id === row.dataset.device);
      if (!d?.online) return;
      const state = currentState();
      if (!state.track) return toast('Nothing is playing');
      const ok = await api
        .invoke('pi:command', d.id, { action: 'play', track: state.track, positionMs: state.positionMs, queue: state.queue })
        .catch(() => false);
      if (ok) {
        audio.pause();
        toast(`Playing on ${d.name}`);
        popup.classList.add('hidden');
      } else toast('Could not reach that device');
    };
  });
  popup.querySelectorAll('[data-continue]').forEach((btn) => {
    btn.onclick = async () => {
      const d = others.find((x) => x.id === btn.dataset.continue);
      const s = d?.state;
      if (!s?.track) return;
      const elapsed = s.playing && s.updatedAt ? Date.now() - s.updatedAt : 0;
      await player.playList([s.track, ...(s.queue ?? [])].map(fromPi), 0, ((s.positionMs ?? 0) + elapsed) / 1000);
      if (s.playing) void api.invoke('pi:command', d.id, { action: 'pause' }).catch(() => {});
      toast(`Continuing from ${d.name}`);
      popup.classList.add('hidden');
    };
  });
}

// ======================================================================
// Pages
// ======================================================================
const route = { name: 'home', arg: null };
const history = [];

function go(name, arg = null, push = true) {
  if (push && (route.name !== name || route.arg !== arg)) history.push({ ...route });
  route.name = name;
  route.arg = arg;
  document.querySelectorAll('.nav-item[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#main').scrollTop = 0;
  const pages = { home: renderHome, search: renderSearch, library: renderLibrary, mixes: renderMixes, settings: renderSettings, playlist: renderPlaylist, album: renderAlbum, artist: renderArtist, mix: renderMix };
  (pages[name] ?? renderHome)(arg);
}

document.querySelectorAll('.nav-item[data-route]').forEach((a) => (a.onclick = () => go(a.dataset.route)));
document.addEventListener('mouseup', (e) => {
  if (e.button === 3 && history.length) {
    const prev = history.pop();
    go(prev.name, prev.arg, false);
  }
});

const loading = () => (view.innerHTML = '<div class="loader"></div>');
const showError = (err) =>
  (view.innerHTML = `<div class="empty">Something went wrong: ${esc(err?.message ?? err)}<br/><br/><button class="btn" id="retry">Try again</button></div>`) &&
  ($('#retry').onclick = () => go(route.name, route.arg, false));

function cardHtml(item, i) {
  const art = thumbOf(item);
  return `<div class="card ${item.kind === 'artist' ? 'artist' : ''}" data-i="${i}">
    <div class="art">${art ? `<img src="${esc(art)}" alt="" loading="lazy" />` : ''}
      ${item.kind !== 'artist' ? `<div class="play-overlay">${ICON_PLAY}</div>` : ''}</div>
    <div class="t ellipsis">${esc(item.title)}</div>
    <div class="s ellipsis muted">${esc(item.subtitle)}</div>
  </div>`;
}

function openItem(item, list, idx, playNow = false) {
  if (item.kind === 'song') {
    const songs = list.filter((x) => x.kind === 'song');
    void player.playList(songs, songs.indexOf(item));
  } else if (item.kind === 'playlist') {
    if (playNow) void playCollection('playlist', item.id);
    else go('playlist', item.id);
  } else if (item.kind === 'album') {
    if (playNow) void playCollection('album', item.id);
    else go('album', item.id);
  } else if (item.kind === 'artist' || item.kind === 'library_artist') go('artist', item.id);
}

async function playCollection(kind, id) {
  try {
    const data = await api.invoke(kind === 'album' ? 'yt:album' : 'yt:playlist', id);
    void player.playList(data.items, 0);
  } catch (err) {
    toast(`Couldn't open: ${err.message}`);
  }
}

function bindCards(root, items) {
  root.querySelectorAll('.card[data-i]').forEach((card) => {
    const item = items[Number(card.dataset.i)];
    card.onclick = (e) => openItem(item, items, Number(card.dataset.i), Boolean(e.target.closest('.play-overlay')));
  });
}

function shelvesHtml(shelves) {
  return shelves
    .map((s, si) => {
      const songsOnly = s.items.every((i) => i.kind === 'song');
      if (songsOnly && s.items.length > 4) {
        return `<h2>${esc(s.title)}</h2><div class="tracks" data-shelf="${si}">${tracksHtml(s.items.slice(0, 12))}</div>`;
      }
      return `<h2>${esc(s.title)}</h2><div class="shelf" data-shelf="${si}">${s.items.map(cardHtml).join('')}</div>`;
    })
    .join('');
}

function bindShelves(shelves) {
  shelves.forEach((s, si) => {
    const el = view.querySelector(`[data-shelf="${si}"]`);
    if (!el) return;
    if (el.classList.contains('tracks')) bindTracks(el, s.items.slice(0, 12));
    else bindCards(el, s.items);
  });
}

function tracksHtml(items) {
  const playing = player.current?.id;
  return items
    .map(
      (t, i) => `<div class="track ${t.id === playing ? 'playing' : ''}" data-i="${i}" data-id="${esc(t.id)}">
      <div class="num">${i + 1}</div>
      <img src="${esc(thumbOf(t))}" alt="" loading="lazy" />
      <div><div class="ellipsis t1">${esc(t.title)}</div><div class="ellipsis muted" style="font-size:13px">${esc(t.subtitle)}</div></div>
      <div class="ellipsis muted col-album">${esc(t.album ?? '')}</div>
      <div class="dur">${t.duration ? fmt(t.duration) : ''}</div>
    </div>`,
    )
    .join('');
}

function bindTracks(root, items) {
  root.querySelectorAll('.track[data-i]').forEach((row) => {
    row.ondblclick = row.onclick = () => void player.playList(items, Number(row.dataset.i));
  });
}

async function renderHome() {
  loading();
  try {
    const shelves = await api.invoke('yt:home');
    if (route.name !== 'home') return;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    view.innerHTML = `<h1>${hello}</h1>${shelves.length ? shelvesHtml(shelves) : '<div class="empty">Nothing here yet. Try Search!</div>'}`;
    bindShelves(shelves);
  } catch (err) {
    showError(err);
  }
}

let lastQuery = '';
function renderSearch() {
  view.innerHTML = `<h1>Search</h1>
    <div class="search-box">
      <span class="ms">search</span>
      <input id="q" placeholder="Songs, artists, albums, playlists" value="${esc(lastQuery)}" autofocus />
      <div class="suggestions hidden" id="sugg"></div>
    </div>
    <div id="results"></div>`;
  const input = $('#q');
  const sugg = $('#sugg');
  let timer = null;
  const run = async (q) => {
    sugg.classList.add('hidden');
    if (!q.trim()) return;
    lastQuery = q;
    const results = $('#results');
    results.innerHTML = '<div class="loader"></div>';
    try {
      const shelves = await api.invoke('yt:search', q);
      if (route.name !== 'search') return;
      results.innerHTML = shelves.length ? shelvesHtml(shelves) : '<div class="empty">No results</div>';
      bindShelves(shelves);
    } catch (err) {
      results.innerHTML = `<div class="empty">Search failed: ${esc(err.message)}</div>`;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void run(input.value);
    if (e.key === 'Escape') sugg.classList.add('hidden');
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    if (!q.trim()) return sugg.classList.add('hidden');
    timer = setTimeout(async () => {
      const list = await api.invoke('yt:suggest', q).catch(() => []);
      if (input.value !== q || !list.length) return;
      sugg.innerHTML = list.map((s) => `<div><span class="ms muted">search</span><span>${esc(s)}</span></div>`).join('');
      sugg.classList.remove('hidden');
      sugg.querySelectorAll(':scope > div').forEach((d) => {
        const q2 = d.lastElementChild.textContent;
        d.onclick = () => ((input.value = q2), run(q2));
      });
    }, 220);
  });
  input.focus();
  if (lastQuery) void run(lastQuery);
}

async function renderLibrary() {
  loading();
  try {
    const lib = await api.invoke('yt:library');
    if (route.name !== 'library') return;
    if (!lib.loggedIn) {
      view.innerHTML = `<h1>Library</h1><div class="empty">Sign in with your YouTube Music account to see your playlists and liked songs.<br/><br/>
        <button class="btn primary" id="login">Sign in to YouTube Music</button></div>`;
      $('#login').onclick = () => api.invoke('auth:login');
      return;
    }
    view.innerHTML = `<h1>Library</h1><div class="grid">${lib.playlists.map(cardHtml).join('')}</div>
      ${lib.playlists.length <= 1 ? '<div class="empty">Only a few playlists showed up. Settings → Account check tells you what YouTube Music answered.</div>' : ''}`;
    bindCards(view, lib.playlists);
  } catch (err) {
    showError(err);
  }
}

async function renderSidePlaylists() {
  const box = $('#side-playlists');
  try {
    const lib = await api.invoke('yt:library');
    box.innerHTML = lib.loggedIn
      ? lib.playlists.map((p, i) => `<a class="nav-item" data-pi="${i}"><span class="ellipsis">${esc(p.title)}</span></a>`).join('')
      : '<div class="nav-item small muted" id="side-login">Sign in to see playlists</div>';
    box.querySelectorAll('[data-pi]').forEach((a) => (a.onclick = () => go('playlist', lib.playlists[Number(a.dataset.pi)].id)));
    const login = $('#side-login');
    if (login) login.onclick = () => api.invoke('auth:login');
  } catch {
    box.innerHTML = '';
  }
}
api.on('library:changed', () => {
  void renderSidePlaylists();
  if (route.name === 'library') renderLibrary();
});

function collectionHtml(kind, data, coverHtml) {
  return `<div class="page-head">
      ${coverHtml}
      <div><div class="kind">${kind}</div><h1>${esc(data.title)}</h1><div class="muted">${esc(data.subtitle ?? '')}</div>
      <div class="actions">
        <button class="btn primary large" id="play-all">${ICON_PLAY} Play</button>
        <button class="btn large" id="shuffle-all">${ICON_SHUFFLE} Shuffle</button>
      </div></div>
    </div>
    <div class="tracks" id="track-list">${tracksHtml(data.items)}</div>`;
}

function bindCollection(items) {
  $('#play-all').onclick = () => void player.playList(items, 0);
  $('#shuffle-all').onclick = () => {
    const shuffled = [...items].sort(() => Math.random() - 0.5);
    void player.playList(shuffled, 0);
  };
  bindTracks($('#track-list'), items);
}

async function renderPlaylist(id) {
  loading();
  try {
    const data = await api.invoke('yt:playlist', id);
    if (route.arg !== id) return;
    const cover = data.thumb || thumbOf(data.items[0]);
    view.innerHTML = collectionHtml('Playlist', data, `<img src="${esc(cover)}" alt="" />`);
    bindCollection(data.items);
  } catch (err) {
    showError(err);
  }
}

async function renderAlbum(id) {
  loading();
  try {
    const data = await api.invoke('yt:album', id);
    if (route.arg !== id) return;
    view.innerHTML = collectionHtml('Album', data, `<img src="${esc(data.thumb ?? '')}" alt="" />`);
    bindCollection(data.items);
  } catch (err) {
    showError(err);
  }
}

async function renderArtist(id) {
  loading();
  try {
    const data = await api.invoke('yt:artist', id);
    if (route.arg !== id) return;
    view.innerHTML = `<div class="page-head"><img class="round" src="${esc(data.thumb ?? '')}" alt="" />
      <div><div class="kind">Artist</div><h1>${esc(data.title)}</h1></div></div>${shelvesHtml(data.sections)}`;
    bindShelves(data.sections);
  } catch (err) {
    showError(err);
  }
}

// ----- AI mixes (from the Pi) -----
let mixesCache = null;
async function renderMixes() {
  view.innerHTML = `<h1>AI mixes</h1>
    <div class="muted" style="max-width:620px;margin-bottom:18px">Your Pi groups the music you like into 2 to 4 styles. Refresh after listening for a while.</div>
    <button class="btn primary" id="refresh-mixes">Refresh AI mixes</button>
    <div id="mix-list" style="margin-top:26px"></div>`;
  const list = $('#mix-list');
  const show = (data) => {
    if (!data) {
      list.innerHTML = `<div class="empty">Can't reach your Pi. Check Settings.</div>`;
      return;
    }
    if (!data.ready) {
      list.innerHTML = `<div class="empty">Not enough data yet: ${data.likedSongs} of ${data.needed} liked songs. Keep listening!</div>`;
      return;
    }
    list.innerHTML = `<div class="grid">${data.mixes
      .map(
        (m, i) => `<div class="card mix-card" data-mix="${i}"><div class="art">${esc(m.name)}<div class="play-overlay">${ICON_PLAY}</div></div>
        <div class="t">AI mix: ${esc(m.name)}</div><div class="s muted">${m.songs.length} songs</div></div>`,
      )
      .join('')}</div>`;
    list.querySelectorAll('[data-mix]').forEach((card) => {
      const mix = data.mixes[Number(card.dataset.mix)];
      card.onclick = (e) => {
        if (e.target.closest('.play-overlay')) void player.playList(mix.songs.map(fromPi), 0);
        else go('mix', Number(card.dataset.mix));
      };
    });
  };
  if (mixesCache) show(mixesCache);
  $('#refresh-mixes').onclick = async () => {
    const btn = $('#refresh-mixes');
    btn.disabled = true;
    btn.textContent = 'Making your AI mixes…';
    mixesCache = await api.invoke('pi:mixes').catch(() => null);
    btn.disabled = false;
    btn.textContent = 'Refresh AI mixes';
    show(mixesCache);
  };
  if (!mixesCache) $('#refresh-mixes').click();
}

function renderMix(index) {
  const mix = mixesCache?.mixes?.[index];
  if (!mix) return go('mixes');
  const items = mix.songs.map(fromPi);
  view.innerHTML = collectionHtml('AI mix', { title: `AI mix: ${mix.name}`, subtitle: `${items.length} songs picked by your Pi`, items }, `<div class="mix-cover">${esc(mix.name)}</div>`);
  bindCollection(items);
}

// ----- Settings -----
let pairCode = null;
async function renderSettings() {
  const status = piStatus === 'online' ? 'Connected' : piStatus === 'offline' ? "Can't reach the Pi" : 'Not set up';
  view.innerHTML = `<h1>Settings</h1>
    <h2>Taste AI (your Pi)</h2>
    <div class="settings-group">
      <div class="setting"><div class="info"><div class="label">Pi address</div><div class="desc">Usually http://umbrel.local:8765</div></div>
        <input type="text" id="s-url" value="${esc(config.serverUrl ?? '')}" /><button class="btn" id="s-url-save">Save</button></div>
      <div class="setting"><span class="dot" data-status="${piStatus}"></span><div class="info"><div class="label">Pi status</div><div class="desc">${status}</div></div>
        <button class="btn" id="s-test">Test</button></div>
      <div class="setting"><div class="info"><div class="label">Smart continue</div><div class="desc">When the queue ends, your Pi picks songs in the same style</div></div>
        <div class="switch ${config.smartContinue ? 'on' : ''}" id="s-smart"></div></div>
    </div>
    <h2>Devices</h2>
    <div class="settings-group">
      <div class="setting"><div class="info"><div class="label">${config.paired ? `Paired as "${esc(config.deviceName)}"` : 'Pair this Mac'}</div>
        <div class="desc">${config.paired ? 'Shows up in Play on, on your phone' : 'Needed for Play on and Continue here'}</div>
        ${pairCode ? `<div style="margin-top:12px"><div class="desc">On your phone: Taste AI → Add a device, and type:</div><div class="code-box">${esc(pairCode.slice(0, 3))} ${esc(pairCode.slice(3))}</div></div>` : ''}</div>
        ${config.paired ? '<button class="btn" id="s-unpair">Unpair</button>' : `<button class="btn primary" id="s-pair" ${pairCode ? 'disabled' : ''}>${pairCode ? 'Waiting…' : 'Pair'}</button>`}</div>
      <div class="setting"><div class="info"><div class="label">Add a device</div><div class="desc">Type the 6-digit code another device shows</div></div>
        <input type="text" id="s-code" placeholder="123456" style="width:120px" ${config.paired ? '' : 'disabled'} /><button class="btn" id="s-approve" ${config.paired ? '' : 'disabled'}>Add</button></div>
      <div class="setting"><div class="info"><div class="label">This Mac's name</div></div>
        <input type="text" id="s-name" value="${esc(config.deviceName ?? '')}" /><button class="btn" id="s-name-save">Save</button></div>
    </div>
    <h2>YouTube Music account</h2>
    <div class="settings-group">
      <div class="setting"><div class="info"><div class="label">${config.loggedIn ? 'Signed in' : 'Not signed in'}</div><div class="desc">Your playlists and likes come from your YouTube Music account</div></div>
        ${config.loggedIn ? '<button class="btn" id="s-logout">Sign out</button>' : '<button class="btn primary" id="s-login">Sign in</button>'}</div>
      <div class="setting"><div class="info"><div class="label">Account check</div><div class="desc" id="s-diag">Checks what YouTube Music sends back for your library and liked songs</div></div>
        <button class="btn" id="s-diag-run">Check</button></div>
    </div>`;
  $('#s-diag-run').onclick = async () => {
    $('#s-diag').textContent = 'Checking…';
    try {
      const r = await api.invoke('yt:diagnose');
      const el = $('#s-diag');
      el.textContent = r;
      el.style.whiteSpace = 'pre-wrap';
      el.style.userSelect = 'text';
    } catch (err) {
      $('#s-diag').textContent = `Check failed: ${err.message}`;
    }
  };

  $('#s-url-save').onclick = async () => {
    await api.invoke('config:set', { serverUrl: $('#s-url').value.trim() });
    toast('Saved');
  };
  $('#s-test').onclick = async () => {
    const h = await api.invoke('pi:health').catch(() => null);
    toast(h?.ok ? `Connected · ${h.events} listens learned` : "Can't reach your Pi");
  };
  $('#s-smart').onclick = () => void api.invoke('config:set', { smartContinue: !config.smartContinue });
  $('#s-name-save').onclick = async () => {
    await api.invoke('config:set', { deviceName: $('#s-name').value.trim() });
    toast('Saved');
  };
  const pair = $('#s-pair');
  if (pair)
    pair.onclick = async () => {
      const res = await api.invoke('pi:pair').catch(() => ({ error: 'offline' }));
      if (res.error) return toast("Can't reach your Pi");
      if (res.paired) return toast('This Mac is paired!');
      pairCode = res.code;
      renderSettings();
    };
  const unpair = $('#s-unpair');
  if (unpair) unpair.onclick = () => api.invoke('pi:unpair');
  $('#s-approve').onclick = async () => {
    const r = await api.invoke('pi:approve', $('#s-code').value).catch(() => 'offline');
    toast(r === 'paired' ? 'Device added!' : r === 'wrong' ? 'Wrong or expired code' : "Can't reach your Pi");
  };
  const login = $('#s-login');
  if (login) login.onclick = () => api.invoke('auth:login');
  const logout = $('#s-logout');
  if (logout) logout.onclick = () => api.invoke('auth:logout');
}

api.on('pi:paired', (ok) => {
  pairCode = null;
  toast(ok ? 'This Mac is paired!' : 'Pairing code expired');
  if (route.name === 'settings') renderSettings();
});

api.on('config', (c) => {
  const wasLoggedIn = config.loggedIn;
  config = c;
  if (route.name === 'settings') renderSettings();
  if (wasLoggedIn !== c.loggedIn) {
    void renderSidePlaylists();
    if (route.name === 'home') renderHome();
  }
});

// ======================================================================
// Start
// ======================================================================
(async () => {
  config = await api.invoke('config:get').catch(() => ({}));
  piStatus = await api.invoke('pi:status').catch(() => 'off');
  audio.volume = config.volume ?? 0.8;
  vol.value = Math.round(audio.volume * 100);
  vol.style.setProperty('--fill', `${vol.value}%`);
  renderPiStatus();
  renderPlayState();
  renderLike();
  go('home', null, false);
  void renderSidePlaylists();
})();
