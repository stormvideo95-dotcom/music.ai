// Music AI for Mac — runs inside the hidden YouTube Music page that actually plays the audio.
// YouTube only hands out complete songs to its own player, so the app drives that player invisibly
// and shows its own interface on top.
const { ipcRenderer } = require('electron');

// ---- remove ads from YouTube's answers before the player sees them ----
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
const prune = (o) => {
  try {
    if (o && typeof o === 'object') {
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse && typeof o.playerResponse === 'object') {
        for (const k of AD_KEYS) if (k in o.playerResponse) delete o.playerResponse[k];
      }
    }
  } catch {
    /* leave untouched */
  }
  return o;
};
const origParse = JSON.parse;
JSON.parse = function (...args) {
  return prune(origParse.apply(this, args));
};
const origJson = Response.prototype.json;
Response.prototype.json = async function (...args) {
  return prune(await origJson.apply(this, args));
};
let initialPlayerResponse;
try {
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initialPlayerResponse,
    set: (v) => {
      initialPlayerResponse = prune(v);
    },
  });
} catch {
  /* ignore */
}

// ---- media keys go to the app, not to YouTube Music's own queue ----
try {
  const session = navigator.mediaSession;
  const original = session.setActionHandler.bind(session);
  const mine = {
    nexttrack: () => ipcRenderer.send('hp:event', 'next'),
    previoustrack: () => ipcRenderer.send('hp:event', 'prev'),
    play: () => ipcRenderer.send('hp:event', 'mk-play'),
    pause: () => ipcRenderer.send('hp:event', 'mk-pause'),
  };
  session.setActionHandler = (action, handler) => {
    try {
      original(action, mine[action] ?? handler);
    } catch {
      /* unsupported action */
    }
  };
  for (const [action, fn] of Object.entries(mine)) original(action, fn);
} catch {
  /* no media session */
}

// ---- player control ----
let wantId = null;
let wantPlaying = true;
let endedFor = null;
let seekOnce = 0;
let seenWant = false; // the player has really switched to the wanted song
let volume = 0.8;

const video = () => document.querySelector('video');
const ytPlayer = () => document.querySelector('#movie_player');
const currentId = () => {
  try {
    return ytPlayer()?.getVideoData?.().video_id ?? null;
  } catch {
    return null;
  }
};
const applyVolume = () => {
  try {
    const p = ytPlayer();
    p?.unMute?.();
    p?.setVolume?.(Math.round(volume * 100));
    const v = video();
    if (v) {
      v.muted = false;
      v.volume = volume;
    }
  } catch {
    /* not ready */
  }
};

window.__musicai = {
  /** The page itself is already loading this song (after a navigation). */
  adopt(id, pos, playing, vol) {
    wantId = id;
    wantPlaying = playing;
    endedFor = null;
    seenWant = false;
    seekOnce = pos > 1 ? pos : 0;
    volume = vol;
  },
  /** Switch song without reloading the page. Returns false when the player isn't there yet. */
  load(id, pos, vol) {
    const p = ytPlayer();
    if (!p?.loadVideoById) return false;
    wantId = id;
    wantPlaying = true;
    endedFor = null;
    seenWant = false;
    seekOnce = 0;
    volume = vol;
    p.loadVideoById({ videoId: id, startSeconds: pos > 1 ? pos : 0 });
    applyVolume();
    return true;
  },
  play() {
    wantPlaying = true;
    if (endedFor === wantId) return;
    ytPlayer()?.playVideo?.();
    video()?.play().catch(() => {});
  },
  pause() {
    wantPlaying = false;
    ytPlayer()?.pauseVideo?.();
    video()?.pause();
  },
  seek(t) {
    endedFor = null;
    const p = ytPlayer();
    if (p?.seekTo) p.seekTo(t, true);
    else if (video()) video().currentTime = t;
  },
  volume(v) {
    volume = v;
    applyVolume();
  },
};

let lastVolumeFix = 0;
setInterval(() => {
  const v = video();
  const p = ytPlayer();
  if (!v || !p || !wantId) return;

  // An ad slipped through: silence it and jump to its end.
  if (p.classList?.contains('ad-showing') || p.classList?.contains('ad-interrupting')) {
    v.muted = true;
    if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
    document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button')?.click();
    return;
  }

  const id = currentId();
  if (id && id !== wantId) {
    // Still switching to the wanted song: wait.
    if (!seenWant) return;
    // YouTube Music moved on by itself: our song is over.
    if (endedFor !== wantId) {
      endedFor = wantId;
      v.pause();
      p.pauseVideo?.();
      ipcRenderer.send('hp:event', 'ended');
    } else if (!v.paused) {
      v.pause();
    }
    return;
  }
  if (id !== wantId) return;
  seenWant = true;

  const d = Number.isFinite(v.duration) ? v.duration : 0;
  if (seekOnce && v.readyState >= 1) {
    const t = seekOnce;
    seekOnce = 0;
    window.__musicai.seek(t);
  }
  if (d > 0 && v.currentTime >= d - 0.45 && endedFor !== wantId) {
    endedFor = wantId;
    v.pause();
    p.pauseVideo?.();
    ipcRenderer.send('hp:event', 'ended');
  } else if (wantPlaying && v.paused && endedFor !== wantId && v.readyState >= 2) {
    v.play().catch(() => {});
  } else if (!wantPlaying && !v.paused) {
    v.pause();
  }
  if (Date.now() - lastVolumeFix > 2000) {
    lastVolumeFix = Date.now();
    if (v.muted || Math.abs(v.volume - volume) > 0.02) applyVolume();
  }
  // "Are you still listening?" and similar dialogs
  document.querySelector('ytmusic-you-there-renderer button, tp-yt-paper-dialog .yt-spec-button-shape-next--call-to-action')?.click?.();

  ipcRenderer.send('hp:state', {
    id,
    t: v.currentTime,
    d,
    paused: endedFor === wantId ? true : !wantPlaying || (v.paused && v.readyState >= 2),
    ready: v.readyState,
  });
}, 250);
