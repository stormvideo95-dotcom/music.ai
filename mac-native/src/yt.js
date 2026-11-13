// YouTube Music engine for Music AI (Mac): search, home, library, playlists and audio streams.
import { Innertube, Platform, UniversalCache } from 'youtubei.js';

// youtubei.js needs a JS evaluator to decipher stream URLs.
Platform.shim.eval = async (data, env) => {
  const q = (v) => JSON.stringify(v ?? '');
  const code = `${data.output}\nreturn process(${q(env.n)}, ${q(env.sp)}, ${q(env.sig)});`;
  return new Function(code)();
};

// Clients tried in order to get a playable audio stream. The first one that works is remembered.
export const STREAM_CLIENTS = ['YTMUSIC', 'ANDROID_VR', 'TV', 'IOS', 'WEB_EMBEDDED', 'MWEB', 'WEB'];

let yt = null;
let ytCookie = '';
let preferredClient = null;
const streamCache = new Map(); // videoId -> { url, expires, mime, client }

export async function getYt(cookie = ytCookie, cacheDir) {
  if (yt && cookie === ytCookie) return yt;
  ytCookie = cookie;
  yt = await Innertube.create({
    cookie: cookie || undefined,
    retrieve_player: true,
    generate_session_locally: false,
    cache: cacheDir ? new UniversalCache(true, cacheDir) : undefined,
  });
  streamCache.clear();
  return yt;
}

export const isLoggedIn = () => Boolean(yt?.session?.logged_in);

// ---------- mapping YouTube objects to simple items for the UI ----------

const text = (t) => (typeof t === 'string' ? t : t?.text ?? t?.toString?.() ?? '');

const bestThumb = (thumbs) => {
  const list = Array.isArray(thumbs) ? thumbs : thumbs?.contents ?? [];
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
};

const hiRes = (url, id) => {
  if (!url && id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  if (!url) return null;
  // googleusercontent thumbnails can be resized via the =wNNN-hNNN suffix
  return url.replace(/=w\d+-h\d+/, '=w544-h544');
};

export function mapItem(node) {
  if (!node) return null;
  const type = node.type;
  if (type === 'MusicResponsiveListItem') {
    const kind = node.item_type;
    const thumb = hiRes(bestThumb(node.thumbnail?.contents ?? node.thumbnails), kind === 'song' || kind === 'video' ? node.id : null);
    const artists = (node.artists ?? node.authors ?? []).map((a) => a.name).filter(Boolean);
    return {
      kind: kind === 'video' || kind === 'non_music_track' ? 'song' : kind,
      id: node.id,
      title: node.title ?? node.name ?? text(node.flex_columns?.[0]?.title),
      subtitle: artists.join(', ') || text(node.subtitle) || node.author?.name || '',
      artists,
      album: node.album?.name ?? null,
      duration: node.duration?.seconds ?? 0,
      thumb,
    };
  }
  if (type === 'MusicTwoRowItem') {
    const kind = node.item_type;
    const artists = (node.artists ?? []).map((a) => a.name);
    return {
      kind: kind === 'video' ? 'song' : kind,
      id: node.id ?? node.endpoint?.payload?.videoId ?? node.endpoint?.payload?.browseId,
      title: text(node.title),
      subtitle: text(node.subtitle),
      artists,
      album: null,
      duration: 0,
      thumb: hiRes(bestThumb(node.thumbnail), kind === 'song' || kind === 'video' ? node.id : null),
    };
  }
  if (type === 'PlaylistPanelVideo') {
    const artists = (node.artists ?? []).map((a) => a.name);
    return {
      kind: 'song',
      id: node.video_id,
      title: text(node.title),
      subtitle: artists.join(', ') || node.author || '',
      artists: artists.length ? artists : [node.author].filter(Boolean),
      album: node.album?.name ?? null,
      duration: node.duration?.seconds ?? 0,
      thumb: hiRes(bestThumb(node.thumbnail), node.video_id),
    };
  }
  if (type === 'PlaylistPanelVideoWrapper') return mapItem(node.primary);
  return null;
}

const mapList = (nodes) =>
  (nodes ?? []).map(mapItem).filter((it) => it && it.id && it.kind && it.kind !== 'unknown');

// ---------- browse ----------

export async function home() {
  const y = await getYt();
  const feed = await y.music.getHomeFeed();
  return (feed.sections ?? [])
    .map((s) => ({
      title: text(s.header?.title) || '',
      items: mapList(s.contents),
    }))
    .filter((s) => s.items.length);
}

export async function search(query) {
  const y = await getYt();
  const res = await y.music.search(query);
  const shelves = [];
  const add = (title, shelf) => {
    const items = mapList(shelf?.contents);
    if (items.length) shelves.push({ title, items });
  };
  add('Songs', res.songs);
  add('Albums', res.albums);
  add('Artists', res.artists);
  add('Playlists', res.playlists);
  add('Videos', res.videos);
  return shelves;
}

export async function suggestions(query) {
  const y = await getYt();
  const sections = await y.music.getSearchSuggestions(query);
  const out = [];
  for (const s of sections ?? []) {
    for (const c of s.contents ?? []) {
      const t = text(c.suggestion) || text(c.title);
      if (t) out.push(t);
    }
  }
  return out.slice(0, 8);
}

export async function playlist(id) {
  const y = await getYt();
  let pl = await y.music.getPlaylist(id);
  const header = pl.header;
  const items = mapList(pl.items);
  let guard = 0;
  while (pl.has_continuation && items.length < 500 && guard++ < 10) {
    pl = await pl.getContinuation();
    items.push(...mapList(pl.items));
  }
  return {
    id,
    title: text(header?.title) || 'Playlist',
    subtitle: text(header?.subtitle) || text(header?.strapline_text_one) || '',
    thumb: hiRes(bestThumb(header?.thumbnail?.contents ?? header?.thumbnails ?? pl.background?.contents)),
    items: items.filter((i) => i.kind === 'song'),
  };
}

export async function album(id) {
  const y = await getYt();
  const al = await y.music.getAlbum(id);
  const header = al.header;
  const thumb = hiRes(bestThumb(header?.thumbnail?.contents ?? header?.thumbnails ?? al.background?.contents));
  const artist = text(header?.strapline_text_one) || text(header?.subtitle) || '';
  const items = mapList(al.contents).map((t) => ({
    ...t,
    thumb: thumb ?? t.thumb,
    subtitle: t.subtitle || artist,
    artists: t.artists?.length ? t.artists : [artist].filter(Boolean),
  }));
  return { id, title: text(header?.title), subtitle: artist, thumb, items };
}

export async function artist(id) {
  const y = await getYt();
  const ar = await y.music.getArtist(id);
  const header = ar.header;
  const sections = (ar.sections ?? [])
    .map((s) => ({ title: text(s.header?.title) || text(s.title) || '', items: mapList(s.contents) }))
    .filter((s) => s.items.length);
  return {
    id,
    title: text(header?.title),
    thumb: hiRes(bestThumb(header?.thumbnail?.contents ?? header?.thumbnails)),
    sections,
  };
}

export async function library() {
  const y = await getYt();
  if (!y.session.logged_in) return { loggedIn: false, playlists: [] };
  const lib = await y.music.getLibrary();
  const playlists = [];
  for (const section of lib.contents ?? []) {
    for (const it of mapList(section.contents ?? section.items)) {
      if (it.kind === 'playlist') playlists.push(it);
    }
  }
  if (!playlists.some((p) => p.id === 'LM' || p.id === 'VLLM')) {
    playlists.unshift({ kind: 'playlist', id: 'LM', title: 'Liked music', subtitle: 'Auto playlist', thumb: null });
  }
  return { loggedIn: true, playlists };
}

/** Radio / "up next" songs for a video: used for autoplay and smart continue. */
export async function upNext(videoId) {
  const y = await getYt();
  const panel = await y.music.getUpNext(videoId, true);
  return mapList(panel?.contents).filter((i) => i.id !== videoId);
}

export async function like(videoId, liked) {
  const y = await getYt();
  if (!y.session.logged_in) return false;
  try {
    if (liked) await y.interact.like(videoId);
    else await y.interact.removeRating(videoId);
    return true;
  } catch {
    return false;
  }
}

// ---------- audio streams ----------

async function tryClient(y, videoId, client) {
  const info =
    client === 'YTMUSIC'
      ? await y.music.getInfo(videoId)
      : await y.getBasicInfo(videoId, { client });
  const format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' });
  const url = await format.decipher(y.session.player);
  if (!url) throw new Error('no url');
  return { url, mime: format.mime_type, client, duration: info.basic_info?.duration ?? 0 };
}

async function urlWorks(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

export async function resolveStream(videoId) {
  const cached = streamCache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;
  const y = await getYt();
  const order = preferredClient
    ? [preferredClient, ...STREAM_CLIENTS.filter((c) => c !== preferredClient)]
    : STREAM_CLIENTS;
  let lastError = null;
  for (const client of order) {
    try {
      const stream = await tryClient(y, videoId, client);
      if (!(await urlWorks(stream.url))) throw new Error(`stream rejected (${client})`);
      preferredClient = client;
      const expireParam = Number(new URL(stream.url).searchParams.get('expire'));
      const entry = {
        ...stream,
        expires: expireParam ? expireParam * 1000 - 60_000 : Date.now() + 3 * 3600_000,
      };
      streamCache.set(videoId, entry);
      return entry;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('No playable stream');
}

export function forgetStream(videoId) {
  streamCache.delete(videoId);
}
