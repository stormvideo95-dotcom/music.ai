// YouTube Music engine for Music AI (Mac): search, home, library, playlists and audio streams.
import crypto from 'node:crypto';

import { Constants, Innertube, Platform, UniversalCache } from 'youtubei.js';

// youtubei.js needs a JS evaluator to decipher stream URLs.
Platform.shim.eval = async (data, env) => {
  const q = (v) => JSON.stringify(v ?? '');
  const code = `${data.output}\nreturn process(${q(env.n)}, ${q(env.sp)}, ${q(env.sig)});`;
  return new Function(code)();
};

// Clients tried in order to get a playable audio stream. The first one that works is remembered.
// App/TV clients first: web clients (YTMUSIC, WEB) need an extra token now and their streams stop after ~1 MB.
export const STREAM_CLIENTS = ['ANDROID_VR', 'TV', 'IOS', 'YTMUSIC', 'WEB_EMBEDDED', 'MWEB', 'WEB'];

let yt = null;
let ytCookie = '';
let preferredClient = null;
const streamCache = new Map(); // videoId -> { url, expires, mime, client }
const badClients = new Map(); // videoId -> Set of clients whose stream failed

const cookieValue = (cookie, name) => {
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[$]/g, '\\$&')}=([^;]+)`));
  return m ? m[1] : null;
};

/**
 * YouTube Music checks that the auth hash was made for music.youtube.com.
 * youtubei.js always signs for www.youtube.com, which makes YouTube Music treat us as signed out
 * (empty library, empty liked songs). Re-sign those requests the way the YouTube Music website does.
 */
function musicAuthHeader(cookie, origin) {
  const ts = Math.floor(Date.now() / 1000);
  const hash = (sid) => crypto.createHash('sha1').update(`${ts} ${sid} ${origin}`).digest('hex');
  const parts = [];
  const sapisid = cookieValue(cookie, 'SAPISID') ?? cookieValue(cookie, '__Secure-3PAPISID');
  const p1 = cookieValue(cookie, '__Secure-1PAPISID');
  const p3 = cookieValue(cookie, '__Secure-3PAPISID');
  if (sapisid) parts.push(`SAPISIDHASH ${ts}_${hash(sapisid)}`);
  if (p1) parts.push(`SAPISID1PHASH ${ts}_${hash(p1)}`);
  if (p3) parts.push(`SAPISID3PHASH ${ts}_${hash(p3)}`);
  return parts.join(' ');
}

function makeFetch(cookie) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (cookie && url.hostname === 'music.youtube.com') {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      const origin = 'https://music.youtube.com';
      headers.set('Authorization', musicAuthHeader(cookie, origin));
      headers.set('Origin', origin);
      headers.set('X-Origin', origin);
      headers.set('Referer', `${origin}/`);
      headers.set('Cookie', cookie);
      init = { ...init, headers };
    }
    return fetch(input, init);
  };
}

export async function getYt(cookie = ytCookie, cacheDir) {
  if (yt && cookie === ytCookie) return yt;
  ytCookie = cookie;
  yt = await Innertube.create({
    fetch: makeFetch(cookie),
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
    let kind = node.item_type;
    if ((kind === 'unknown' || kind === 'endpoint') && node.endpoint?.payload?.videoId) {
      kind = 'song';
      node.id = node.id ?? node.endpoint.payload.videoId;
    }
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


// ---------- raw parsing (fallback when youtubei.js's parser finds nothing) ----------

const runsText = (t) => (t?.runs ?? []).map((r) => r.text).join('') || t?.simpleText || '';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (visit(node) === false) return;
  for (const v of Object.values(node)) walk(v, visit);
}

function rawSongFromRenderer(r) {
  const cols = (r.flexColumns ?? []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
  const titleRun = cols[0]?.runs?.[0];
  const videoId =
    r.playlistItemData?.videoId ??
    titleRun?.navigationEndpoint?.watchEndpoint?.videoId ??
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const artistRuns = (cols[1]?.runs ?? []).filter((x) => x.navigationEndpoint?.browseEndpoint);
  const artists = artistRuns.length
    ? artistRuns.map((x) => x.text)
    : [runsText(cols[1]).split(' • ')[0]].filter(Boolean);
  const durationText = runsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const duration = durationText.split(':').reduce((acc, n) => acc * 60 + (Number(n) || 0), 0);
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
  return {
    kind: 'song',
    id: videoId,
    title: runsText(cols[0]),
    subtitle: artists.join(', '),
    artists,
    album: runsText(cols[2]) || null,
    duration,
    thumb: hiRes(bestThumb(thumbs), videoId),
  };
}

function rawContinuation(data) {
  let token = null;
  walk(data, (n) => {
    if (token) return false;
    token = n.continuationCommand?.token ?? n.nextContinuationData?.continuation ?? null;
  });
  return token;
}

async function rawPlaylistItems(y, browseId, max = 500) {
  const items = [];
  const seen = new Set();
  const collect = (data) => {
    walk(data, (n) => {
      if (n.musicResponsiveListItemRenderer) {
        const song = rawSongFromRenderer(n.musicResponsiveListItemRenderer);
        if (song && !seen.has(song.id)) {
          seen.add(song.id);
          items.push(song);
        }
        return false;
      }
    });
  };
  let res = await y.actions.execute('/browse', { browseId, client: 'YTMUSIC' });
  collect(res.data);
  let token = rawContinuation(res.data);
  for (let page = 0; token && items.length < max && page < 15; page++) {
    res = await y.actions.execute('/browse', { continuation: token, client: 'YTMUSIC' });
    const before = items.length;
    collect(res.data);
    token = items.length > before ? rawContinuation(res.data) : null;
  }
  return items;
}

async function rawLibraryPlaylists(y) {
  const res = await y.actions.execute('/browse', { browseId: 'FEmusic_liked_playlists', client: 'YTMUSIC' });
  const out = [];
  walk(res.data, (n) => {
    const r = n.musicTwoRowItemRenderer;
    if (!r) return;
    const browseId = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (browseId && /^VL/.test(browseId)) {
      out.push({
        kind: 'playlist',
        id: browseId,
        title: runsText(r.title),
        subtitle: runsText(r.subtitle),
        thumb: hiRes(bestThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [])),
      });
    }
    return false;
  });
  return out;
}

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

function collectShelfItems(nodes, out = []) {
  for (const node of nodes ?? []) {
    if (!node) continue;
    if (node.type === 'MusicShelf' || node.type === 'Shelf') out.push(...(node.contents ?? []));
    else if (node.type === 'MusicCardShelf') out.push(...(node.contents ?? []));
    else if (node.type === 'ItemSection' || node.type === 'SectionList') collectShelfItems(node.contents, out);
    else if (node.type === 'MusicResponsiveListItem' || node.type === 'MusicTwoRowItem') out.push(node);
  }
  return out;
}

const SEARCH_GROUPS = [
  ['Songs', 'song'],
  ['Albums', 'album'],
  ['Artists', 'artist'],
  ['Playlists', 'playlist'],
  ['Videos', 'video'],
];

export async function search(query) {
  const y = await getYt();
  // One filtered search per type: works no matter how YouTube names or orders the shelves.
  const results = await Promise.allSettled(
    SEARCH_GROUPS.map(([, type]) => y.music.search(query, { type })),
  );
  const shelves = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const [title, type] = SEARCH_GROUPS[i];
    let items = mapList(collectShelfItems(r.value.contents));
    if (type === 'video') items = items.map((it) => ({ ...it, kind: 'song' }));
    else if (type === 'song') items = items.filter((it) => it.kind === 'song');
    else items = items.filter((it) => it.kind === type || (type === 'artist' && it.kind === 'library_artist'));
    if (items.length) shelves.push({ title, items: items.slice(0, type === 'song' ? 20 : 12) });
  });
  return shelves;
}

/** Debug helper for the CI smoke test. */
export async function searchDebug(query) {
  const y = await getYt();
  const res = await y.music.search(query, { type: 'song' });
  return (res.contents ?? []).map((c) => `${c.type}(${(c.contents ?? []).length}: ${(c.contents ?? []).slice(0, 2).map((x) => `${x.type}/${x.item_type}/${x.id}`).join(',')})`);
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
  let header = null;
  let pl = null;
  const items = [];
  try {
    pl = await y.music.getPlaylist(id);
    header = pl.header;
    items.push(...mapList(pl.items));
    let guard = 0;
    while (pl.has_continuation && items.length < 500 && guard++ < 10) {
      pl = await pl.getContinuation();
      items.push(...mapList(pl.items));
    }
  } catch (err) {
    console.warn('[playlist] parser failed, using raw', err?.message);
  }
  let songs = items.filter((i) => i.kind === 'song');
  if (!songs.length) {
    // The parser didn't recognise the list (YouTube changes it often): read the raw answer instead.
    songs = await rawPlaylistItems(y, id.startsWith('VL') ? id : `VL${id}`);
  }
  return {
    id,
    title: text(header?.title) || 'Playlist',
    subtitle: text(header?.subtitle) || text(header?.strapline_text_one) || '',
    thumb: hiRes(bestThumb(header?.thumbnail?.contents ?? header?.thumbnails ?? pl?.background?.contents)),
    items: songs,
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
  let lib = await y.music.getLibrary();
  const collect = (l) => {
    const out = [];
    for (const section of l.contents ?? []) {
      for (const it of mapList(section.contents ?? section.items)) {
        if (it.kind === 'playlist' && !out.some((p) => p.id === it.id)) out.push(it);
      }
    }
    return out;
  };
  let playlists = collect(lib);
  if (!playlists.length && lib.filters?.length) {
    const name = lib.filters.find((f) => /playlist/i.test(f));
    if (name) {
      lib = await lib.applyFilter(name);
      playlists = collect(lib);
    }
  }
  if (playlists.length < 2) {
    try {
      for (const p of await rawLibraryPlaylists(y)) {
        if (!playlists.some((x) => x.id === p.id)) playlists.push(p);
      }
    } catch (err) {
      console.warn('[library] raw fallback failed', err);
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
  if (!y.session.logged_in) throw new Error('not signed in');
  const endpoint = liked ? '/like/like' : '/like/removelike';
  // Through YouTube Music first (same place the YouTube Music app saves likes), then plain YouTube.
  try {
    const res = await y.actions.execute(endpoint, { client: 'YTMUSIC', target: { videoId } });
    if (res.success) return true;
  } catch (err) {
    console.warn('[like] music endpoint failed', err?.message);
  }
  if (liked) await y.interact.like(videoId);
  else await y.interact.removeRating(videoId);
  return true;
}

// ---------- audio streams ----------

/**
 * Pick an audio format the Mac app can really play: plain stereo Opus or AAC.
 * (Some sources also offer surround / Dolby tracks with a higher bitrate; the player can't decode those.)
 */
function pickAudioFormat(info) {
  const all = [...(info.streaming_data?.adaptive_formats ?? []), ...(info.streaming_data?.formats ?? [])];
  const audio = all.filter((f) => f.has_audio && !f.has_video && /opus|mp4a\.40\.(2|5)/.test(f.mime_type ?? ''));
  const score = (f) =>
    ((f.audio_channels ?? 2) <= 2 ? 1e9 : 0) +
    (f.is_drc ? 0 : 1e8) +
    (f.is_dubbed || f.is_auto_dubbed || f.is_original === false ? 0 : 1e7) +
    (f.bitrate ?? 0);
  const best = audio.sort((a, b) => score(b) - score(a))[0];
  if (best) return best;
  return info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' });
}

async function tryClient(y, videoId, client) {
  const info =
    client === 'YTMUSIC'
      ? await y.music.getInfo(videoId)
      : await y.getBasicInfo(videoId, { client });
  const ps = info.playability_status;
  if (ps?.status === 'LOGIN_REQUIRED') {
    const err = new Error(`SIGN_IN_REQUIRED: ${ps.reason ?? ''}`);
    err.signIn = true;
    throw err;
  }
  const format = pickAudioFormat(info);
  const url = await format.decipher(y.session.player);
  if (!url) throw new Error('no url');
  // The download has to look like it comes from the same kind of app that asked for the link.
  const ua = Constants.CLIENTS[client]?.USER_AGENT || y.session.user_agent || '';
  return { url, ua, mime: format.mime_type, itag: format.itag, client, duration: info.basic_info?.duration ?? 0 };
}

/** 'full' = start and a later part both load, 'start' = only the start loads, false = nothing. */
async function urlWorks(url, ua) {
  const base = ua ? { 'User-Agent': ua } : {};
  try {
    const first = await fetch(url, { headers: { ...base, Range: 'bytes=0-1023' } });
    if (first.status !== 200 && first.status !== 206) return false;
    const total = Number(first.headers.get('content-range')?.split('/')[1]) || 0;
    if (total > 600_000) {
      const at = Math.min(total - 2048, 1_500_000);
      const later = await fetch(url, { headers: { ...base, Range: `bytes=${at}-${at + 1023}` } });
      if (later.status !== 200 && later.status !== 206) return 'start';
    }
    return 'full';
  } catch {
    return false;
  }
}

// Streams are fetched without the account first (that is what worked before signing in);
// the signed-in session is only the backup, e.g. for age-restricted songs.
let anonYt = null;
async function getAnonYt() {
  anonYt ??= await Innertube.create({ retrieve_player: true, generate_session_locally: false });
  return anonYt;
}

export let lastStreamReport = [];
export let lastFullReport = [];
export const playbackErrors = [];
export function notePlaybackError(text) {
  const line = String(text).slice(0, 200);
  if (playbackErrors.at(-1) === line) return;
  playbackErrors.push(line);
  while (playbackErrors.length > 8) playbackErrors.shift();
}

export async function resolveStream(videoId) {
  const cached = streamCache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;
  const account = await getYt();
  const sessions = [['anon', await getAnonYt().catch(() => null)]];
  if (account.session.logged_in) sessions.push(['account', account]);
  const bad = badClients.get(videoId) ?? new Set();
  let attempts = [];
  for (const [name, y] of sessions) {
    if (y) for (const client of STREAM_CLIENTS) attempts.push({ key: `${name}:${client}`, y, client });
  }
  const usable = attempts.filter((a) => !bad.has(a.key));
  if (usable.length) attempts = usable;
  else badClients.delete(videoId); // every source was marked bad: start fresh instead of giving up for good
  if (preferredClient) attempts.sort((a, b) => (b.key === preferredClient) - (a.key === preferredClient));

  const report = [];
  let fallback = null;
  let signIn = false;
  const finish = (stream, key) => {
    const expireParam = Number(new URL(stream.url).searchParams.get('expire'));
    const entry = {
      ...stream,
      client: key,
      expires: expireParam ? expireParam * 1000 - 60_000 : Date.now() + 3 * 3600_000,
    };
    streamCache.set(videoId, entry);
    return entry;
  };
  for (const { key, y, client } of attempts) {
    try {
      const stream = await tryClient(y, videoId, client);
      const ok = await urlWorks(stream.url, stream.ua);
      report.push(`${key}: ${ok || 'stream refused'} (itag ${stream.itag}, ${String(stream.mime).split(';')[0]})`);
      if (ok === 'full') {
        preferredClient = key;
        lastStreamReport = report;
        if (!bad.size) lastFullReport = report;
        return finish(stream, key);
      }
      if (ok === 'start' && !fallback) fallback = { stream, key };
    } catch (err) {
      if (err?.signIn) signIn = true;
      report.push(`${key}: ${String(err?.message ?? err).slice(0, 90)}`);
    }
  }
  lastStreamReport = report;
  if (!bad.size) lastFullReport = report;
  if (fallback) return finish(fallback.stream, fallback.key);
  if (signIn && !isLoggedIn()) throw new Error('SIGN_IN_REQUIRED');
  throw new Error('No playable stream');
}

/** Debug helper for the CI smoke test: what does each client say? */
export async function debugStreams(videoId) {
  const y = await getYt();
  const out = [];
  for (const client of STREAM_CLIENTS) {
    try {
      const info = client === 'YTMUSIC' ? await y.music.getInfo(videoId) : await y.getBasicInfo(videoId, { client });
      const ps = info.playability_status;
      const formats = info.streaming_data?.adaptive_formats?.length ?? 0;
      let urlStatus = '-';
      if (formats) {
        try {
          const f = info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' });
          const url = await f.decipher(y.session.player);
          const r1 = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
          const r2 = await fetch(url, { headers: { Range: 'bytes=2000000-2001000' } });
          urlStatus = `${r1.status}/${r2.status}`;
        } catch (e) {
          urlStatus = `decipher error: ${e.message}`;
        }
      }
      out.push(`${client}: ${ps?.status} ${ps?.reason ?? ''} formats=${formats} url=${urlStatus}`);
    } catch (e) {
      out.push(`${client}: ERROR ${e.message}`);
    }
  }
  return out;
}

/** Account check shown in Settings, so problems are visible instead of just "empty". */
export async function diagnose() {
  const y = await getYt();
  const lines = [];
  const cookieNames = (ytCookie.match(/(?:^|; )([^=]+)=/g) ?? []).map((c) => c.replace(/^; /, '').replace(/=$/, ''));
  lines.push(`Signed in: ${y.session.logged_in ? 'yes' : 'no'} · cookies: ${cookieNames.length} · SAPISID: ${cookieNames.includes('SAPISID') ? 'yes' : 'no'} · 1P: ${cookieNames.includes('__Secure-1PAPISID') ? 'yes' : 'no'} · 3P: ${cookieNames.includes('__Secure-3PAPISID') ? 'yes' : 'no'}`);

  const accountName = async (client) => {
    try {
      const res = await y.actions.execute('/account/account_menu', client ? { client } : {});
      let name = null;
      let handle = null;
      walk(res.data, (n) => {
        if (n.accountName && !name) name = runsText(n.accountName);
        if (n.channelHandle && !handle) handle = runsText(n.channelHandle);
      });
      return name ? `${name}${handle ? ` (${handle})` : ''}` : 'not signed in';
    } catch (e) {
      return `error: ${e.message.slice(0, 80)}`;
    }
  };
  lines.push(`YouTube Music account: ${await accountName('YTMUSIC')}`);
  lines.push(`YouTube account: ${await accountName(null)}`);

  try {
    lines.push(`Library playlists: ${(await library()).playlists.map((p) => p.title).join(', ')}`);
  } catch (e) {
    lines.push(`Library: error ${e.message.slice(0, 80)}`);
  }

  const rawCheck = async (label, browseId) => {
    try {
      const res = await y.actions.execute('/browse', { browseId, client: 'YTMUSIC' });
      const counts = {};
      walk(res.data, (n) => {
        for (const k of Object.keys(n)) if (k.endsWith('Renderer')) counts[k] = (counts[k] ?? 0) + 1;
      });
      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k.replace('Renderer', '')}×${v}`)
        .join(' ');
      let alert = null;
      walk(res.data, (n) => {
        if (!alert && n.alertRenderer) alert = runsText(n.alertRenderer.text);
      });
      lines.push(`${label}: status ${res.status_code} · ${top || 'nothing'}${alert ? ` · says: ${alert}` : ''}`);
    } catch (e) {
      lines.push(`${label}: error ${e.message.slice(0, 100)}`);
    }
  };
  await rawCheck('Liked songs (VLLM)', 'VLLM');
  await rawCheck('Library songs', 'FEmusic_liked_videos');
  lines.push(`Last song tried: ${lastStreamReport.join(' | ') || 'nothing yet'}`);
  lines.push(`First try of a song: ${lastFullReport.join(' | ') || 'nothing yet'}`);
  lines.push(`Player errors: ${playbackErrors.join(' | ') || 'none'}`);
  return lines.join('\n');
}

/** Called when playback of a stream failed: drop it, and don't use that client again for this song. */
export function forgetStream(videoId, failed = false) {
  const cached = streamCache.get(videoId);
  streamCache.delete(videoId);
  if (failed && cached) {
    const bad = badClients.get(videoId) ?? new Set();
    bad.add(cached.client);
    badClients.set(videoId, bad);
    if (preferredClient === cached.client) preferredClient = null;
  }
}
