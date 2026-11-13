// CI smoke test: runs on GitHub (which can reach YouTube) before packaging.
import * as yt from '../src/yt.js';

const log = (...a) => console.log('[smoke]', ...a);
let failed = false;
const check = async (name, fn) => {
  try {
    const r = await fn();
    log('OK  ', name, r ?? '');
    return r;
  } catch (err) {
    failed = true;
    log('FAIL', name, err?.message ?? err);
    return null;
  }
};

await yt.getYt('');
await check('search structure', async () => (await yt.searchDebug('daft punk get lucky')).join(' ; '));
const shelves = await check('search', async () => {
  const s = await yt.search('daft punk get lucky');
  if (!s.length) throw new Error('no results');
  return s;
});
const song = shelves?.flatMap((s) => s.items).find((i) => i.kind === 'song');
log('first song', song);
const album = shelves?.flatMap((s) => s.items).find((i) => i.kind === 'album');
const playlist = shelves?.flatMap((s) => s.items).find((i) => i.kind === 'playlist');
await check('home', async () => `${(await yt.home()).length} shelves`);
await check('suggestions', async () => (await yt.suggestions('daft')).slice(0, 3).join(' | '));
if (album) await check('album', async () => `${(await yt.album(album.id)).items.length} tracks`);
if (playlist) await check('playlist', async () => `${(await yt.playlist(playlist.id)).items.length} tracks`);
if (song) {
  await check('upNext', async () => `${(await yt.upNext(song.id)).length} songs`);
  await check('stream (app order)', async () => {
    const s = await yt.resolveStream(song.id);
    // also test a later part of the file (catches streams that die after 1 MB)
    const res = await fetch(s.url, { headers: { Range: 'bytes=2000000-2001000' } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`late range ${res.status}`);
    return `client=${s.client} mime=${s.mime}`;
  });
}
console.log('SMOKE_RESULT', failed ? 'FAILED' : 'PASSED');
process.exit(failed ? 1 : 0);
