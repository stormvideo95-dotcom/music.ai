// Music AI for Mac — control script for the real YouTube Music player.
// It is run inside the player page as plain page script (no changes to the browser's built-in
// functions: YouTube's protection notices those and then stops songs after the first part).
export const PLAYER_PAGE_SCRIPT = String.raw`
(() => {
  if (window.__musicai) return;
  const S = { wantId: null, wantPlaying: true, endedFor: null, seekOnce: 0, seenWant: false, started: false, volume: 0.8, events: [], lastT: -1, lastMove: Date.now(), stallNoted: false };
  const video = () => document.querySelector('video');
  const yt = () => document.querySelector('#movie_player');
  const curId = () => { try { return yt()?.getVideoData?.().video_id ?? null; } catch { return null; } };
  const applyVolume = () => {
    try {
      const p = yt(); p?.unMute?.(); p?.setVolume?.(Math.round(S.volume * 100));
      const v = video(); if (v) { v.muted = false; v.volume = S.volume; }
    } catch {}
  };
  const reset = (id, playing) => { S.wantId = id; S.wantPlaying = playing; S.endedFor = null; S.seenWant = false; S.started = false; S.lastT = -1; S.lastMove = Date.now(); S.stallNoted = false; };
  const api = {
    adopt(id, pos, playing, vol) { reset(id, playing); S.seekOnce = pos > 1 ? pos : 0; S.volume = vol; },
    load(id, pos, vol) {
      const p = yt();
      if (!p?.loadVideoById) return false;
      reset(id, true); S.seekOnce = 0; S.volume = vol;
      p.loadVideoById({ videoId: id, startSeconds: pos > 1 ? pos : 0 });
      applyVolume();
      return true;
    },
    play() { S.wantPlaying = true; if (S.endedFor === S.wantId) return; yt()?.playVideo?.(); video()?.play().catch(() => {}); },
    pause() { S.wantPlaying = false; yt()?.pauseVideo?.(); video()?.pause(); },
    seek(t) { S.endedFor = null; S.lastMove = Date.now(); const p = yt(); if (p?.seekTo) p.seekTo(t, true); else if (video()) video().currentTime = t; },
    volume(v) { S.volume = v; applyVolume(); },
    poll() {
      const out = { events: S.events.splice(0), state: null };
      const v = video(); const p = yt();
      if (!v || !p || !S.wantId) return out;
      if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) {
        v.muted = true;
        if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
        document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button')?.click();
        return out;
      }
      const id = curId();
      if (id && id !== S.wantId) {
        if (!S.seenWant) return out;
        if (S.endedFor !== S.wantId) { S.endedFor = S.wantId; v.pause(); p.pauseVideo?.(); out.events.push('ended'); }
        else if (!v.paused) v.pause();
        return out;
      }
      if (id !== S.wantId) return out;
      S.seenWant = true;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      if (S.seekOnce && v.readyState >= 1) { const t = S.seekOnce; S.seekOnce = 0; api.seek(t); }
      if (v.currentTime > 0.3 && !v.paused) S.started = true;
      if (d > 0 && v.currentTime >= d - 0.45 && S.endedFor !== S.wantId) {
        S.endedFor = S.wantId; v.pause(); p.pauseVideo?.(); out.events.push('ended');
      } else if (!S.started && S.wantPlaying && v.paused && v.readyState >= 2) {
        v.play().catch(() => {}); p.playVideo?.();
      }
      if (v.muted || Math.abs(v.volume - S.volume) > 0.02) applyVolume();
      document.querySelector('ytmusic-you-there-renderer button')?.click?.();

      // Stall detection, for the report in Settings.
      if (v.currentTime !== S.lastT) { S.lastT = v.currentTime; S.lastMove = Date.now(); S.stallNoted = false; }
      else if (!v.paused && S.endedFor !== S.wantId && Date.now() - S.lastMove > 8000 && !S.stallNoted) {
        S.stallNoted = true;
        let buf = 0; try { buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch {}
        let perr = ''; try { perr = JSON.stringify(p.getPlayerResponse?.()?.playabilityStatus?.status ?? ''); } catch {}
        out.events.push('stall:' + 'at ' + v.currentTime.toFixed(1) + 's of ' + d.toFixed(0) + 's, buffered to ' + buf.toFixed(1) + 's, ready ' + v.readyState + ', net ' + v.networkState + ', error ' + (v.error?.code ?? 'none') + ', visible ' + document.visibilityState + ', status ' + perr);
      }
      const pausedNow = S.endedFor === S.wantId ? true : (v.paused && v.readyState >= 2 && S.started) || (!S.wantPlaying && v.paused);
      out.state = { id, t: v.currentTime, d, paused: pausedNow, ready: v.readyState };
      return out;
    },
  };
  window.__musicai = api;
})();
`;
