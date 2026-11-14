// Song lyrics for Music AI (Mac): synced lyrics from LRCLIB (free, open database), otherwise YouTube Music's own lyrics.
import { getYt } from './yt.js';

const cache = new Map();

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

// "GOZALO (Super Slowed)" → "GOZALO": versions like slowed/sped up rarely have their own lyrics entry.
const cleanTitle = (t) =>
  t
    .replace(/\s*[([][^)\]]*(slowed|sped|speed|remix|version|edit|reverb|official|video|audio|lyric|visuali[sz]er|remaster)[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(slowed|sped up).*$/i, '')
    .trim();

async function lrclib(track) {
  const headers = { 'User-Agent': 'MusicAI-Mac/1.0 (github.com/stormvideo95-dotcom/music.ai)' };
  const artist = (track.artists?.[0] ?? track.subtitle ?? '').split(',')[0].trim();
  const titles = [...new Set([track.title, cleanTitle(track.title)])].filter(Boolean);
  for (const title of titles) {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (track.duration && title === track.title) params.set('duration', String(Math.round(track.duration)));
    try {
      const res = await fetch(`https://lrclib.net/api/get?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.syncedLyrics || data.plainLyrics) return data;
      }
    } catch {
      /* try next */
    }
  }
  try {
    const q = new URLSearchParams({ q: `${cleanTitle(track.title)} ${artist}` });
    const res = await fetch(`https://lrclib.net/api/search?${q}`, { headers });
    if (res.ok) {
      const list = await res.json();
      return list.find((l) => l.syncedLyrics) ?? list.find((l) => l.plainLyrics) ?? null;
    }
  } catch {
    /* none */
  }
  return null;
}

export async function getLyrics(track) {
  if (cache.has(track.id)) return cache.get(track.id);
  let result = null;
  const found = await lrclib(track);
  if (found?.syncedLyrics) {
    const synced = parseLrc(found.syncedLyrics);
    // Slowed / sped-up versions: stretch the timing to the song's real length.
    const factor = track.duration && found.duration ? track.duration / found.duration : 1;
    if (Math.abs(factor - 1) > 0.04) for (const l of synced) l.t *= factor;
    result = { synced, plain: null, source: 'LRCLIB', adjusted: Math.abs(factor - 1) > 0.04 };
  } else if (found?.plainLyrics) {
    result = { synced: null, plain: found.plainLyrics, source: 'LRCLIB' };
  } else {
    try {
      const y = await getYt();
      const shelf = await y.music.getLyrics(track.id);
      const plain = shelf?.description?.toString?.() ?? '';
      if (plain) result = { synced: null, plain, source: shelf?.footer?.toString?.() || 'YouTube Music' };
    } catch {
      /* no lyrics */
    }
  }
  result ??= { synced: null, plain: null, source: null };
  cache.set(track.id, result);
  return result;
}
