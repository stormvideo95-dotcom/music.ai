"""
Music AI web app (for iPhone): the Pi fetches songs and hands them to the phone as plain audio.

- /                    the web app
- /api/search?q=       song search (YouTube Music)
- /api/upnext?id=      songs that fit after this one
- /audio/<id>          the song itself (downloaded by yt-dlp, kept in a smart cache)
- /api/diag            what went wrong last time, for troubleshooting

Smart cache: songs played at least FAVOURITE_PLAYS times are kept; other songs are deleted a day
after they were last played. The cache never grows past CACHE_MAX_MB (least-played songs go first).
"""

import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.parse

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CACHE_DIR = os.path.join(DATA_DIR, "songs")
CACHE_MAX_MB = int(os.environ.get("CACHE_MAX_MB", "2048"))
FAVOURITE_PLAYS = int(os.environ.get("FAVOURITE_PLAYS", "3"))
KEEP_OTHERS_HOURS = float(os.environ.get("KEEP_OTHERS_HOURS", "24"))
KEEP_FAVOURITES_DAYS = float(os.environ.get("KEEP_FAVOURITES_DAYS", "60"))
POT_URL = os.environ.get("POT_URL", "")
HERE = os.path.dirname(os.path.abspath(__file__))
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

os.makedirs(CACHE_DIR, exist_ok=True)
_db_lock = threading.Lock()
_locks = {}
_locks_guard = threading.Lock()
_diag = {"last_error": None, "last_ok": None, "downloads": 0}
_ytm = None


def _db():
    conn = sqlite3.connect(os.path.join(DATA_DIR, "cache.db"))
    conn.execute("CREATE TABLE IF NOT EXISTS plays (id TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)")
    return conn


def _note_play(song_id):
    with _db_lock:
        conn = _db()
        conn.execute(
            "INSERT INTO plays (id, count, last) VALUES (?, 1, ?) "
            "ON CONFLICT(id) DO UPDATE SET count = count + 1, last = excluded.last",
            (song_id, int(time.time())),
        )
        conn.commit()
        conn.close()


def _plays():
    with _db_lock:
        conn = _db()
        rows = dict((r[0], (r[1], r[2])) for r in conn.execute("SELECT id, count, last FROM plays"))
        conn.close()
    return rows


def _cached_path(song_id):
    for ext in ("m4a", "mp4", "mp3"):
        p = os.path.join(CACHE_DIR, f"{song_id}.{ext}")
        if os.path.exists(p) and os.path.getsize(p) > 50_000:
            return p
    return None


def clean_cache():
    """Delete what the smart cache should not keep. Returns (files kept, MB used)."""
    plays = _plays()
    now = time.time()
    files = []
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        song_id = name.split(".")[0]
        if not os.path.isfile(path):
            continue
        if name.endswith((".part", ".ytdl")):
            if now - os.path.getmtime(path) > 3600:
                os.remove(path)
            continue
        count, last = plays.get(song_id, (0, int(os.path.getmtime(path))))
        age_h = (now - last) / 3600
        favourite = count >= FAVOURITE_PLAYS
        if (not favourite and age_h > KEEP_OTHERS_HOURS) or (favourite and age_h > KEEP_FAVOURITES_DAYS * 24):
            os.remove(path)
            continue
        files.append((count, last, os.path.getsize(path), path))
    total = sum(f[2] for f in files)
    files.sort()  # least played, then oldest, first
    while files and total > CACHE_MAX_MB * 1024 * 1024:
        count, last, size, path = files.pop(0)
        os.remove(path)
        total -= size
    return len(files), round(total / 1024 / 1024, 1)


def _download(song_id):
    out = os.path.join(CACHE_DIR, "%(id)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/best[ext=mp4]",
        "--no-playlist", "--no-progress", "--no-warnings",
        "--retries", "3", "--socket-timeout", "20",
        "-o", out,
    ]
    if POT_URL:
        cmd += ["--extractor-args", f"youtubepot-bgutilhttp:base_url={POT_URL}"]
    cmd.append(f"https://www.youtube.com/watch?v={song_id}")
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    path = _cached_path(song_id)
    if proc.returncode != 0 or not path:
        err = (proc.stderr or proc.stdout or "unknown error").strip().splitlines()[-3:]
        _diag["last_error"] = {"id": song_id, "at": int(time.time()), "error": " | ".join(err)[:600]}
        raise RuntimeError(_diag["last_error"]["error"])
    _diag["downloads"] += 1
    _diag["last_ok"] = {"id": song_id, "at": int(time.time()), "seconds": round(time.time() - started, 1)}
    threading.Thread(target=clean_cache, daemon=True).start()
    return path


def song_file(song_id):
    path = _cached_path(song_id)
    if path:
        return path
    with _locks_guard:
        lock = _locks.setdefault(song_id, threading.Lock())
    with lock:
        return _cached_path(song_id) or _download(song_id)


def _music():
    global _ytm
    if _ytm is None:
        from ytmusicapi import YTMusic

        _ytm = YTMusic()
    return _ytm


def _track(item):
    vid = item.get("videoId")
    if not vid:
        return None
    thumbs = item.get("thumbnails") or item.get("thumbnail") or []
    thumb = thumbs[-1]["url"] if thumbs else f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    dur = item.get("duration_seconds")
    if dur is None:
        text = item.get("length") or item.get("duration") or ""
        dur = 0
        for part in str(text).split(":"):
            dur = dur * 60 + (int(part) if part.isdigit() else 0)
    album = item.get("album")
    return {
        "id": vid,
        "title": item.get("title") or "",
        "artists": [a.get("name") for a in item.get("artists") or [] if a.get("name")],
        "album": album.get("name") if isinstance(album, dict) else None,
        "duration": dur or 0,
        "thumb": re.sub(r"=w\d+-h\d+", "=w300-h300", thumb),
    }


def search(q):
    results = _music().search(q, filter="songs", limit=25)
    return [t for t in (_track(r) for r in results) if t]


def upnext(song_id):
    data = _music().get_watch_playlist(videoId=song_id, radio=True, limit=40)
    return [t for t in (_track(r) for r in data.get("tracks") or []) if t and t["id"] != song_id]


def _send_json(h, code, payload):
    body = json.dumps(payload).encode()
    h.send_response(code)
    h.send_header("Content-Type", "application/json")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def _send_file(h, path, ctype, cache="no-cache"):
    size = os.path.getsize(path)
    start, end = 0, size - 1
    m = re.match(r"bytes=(\d*)-(\d*)", h.headers.get("Range") or "")
    partial = False
    if m and (m.group(1) or m.group(2)):
        partial = True
        if m.group(1):
            start = int(m.group(1))
            if m.group(2):
                end = min(int(m.group(2)), size - 1)
        else:
            start = max(0, size - int(m.group(2)))
    if start > end or start >= size:
        h.send_response(416)
        h.send_header("Content-Range", f"bytes */{size}")
        h.end_headers()
        return
    h.send_response(206 if partial else 200)
    h.send_header("Content-Type", ctype)
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(end - start + 1))
    h.send_header("Cache-Control", cache)
    if partial:
        h.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    h.end_headers()
    try:
        with open(path, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(65536, left))
                if not chunk:
                    break
                h.wfile.write(chunk)
                left -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


def handle_get(h, path, params):
    """Returns True when the request was for the web app."""
    if path in ("/", "/index.html"):
        _send_file(h, os.path.join(HERE, "webapp.html"), "text/html; charset=utf-8")
        return True
    if path in ("/icon.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"):
        _send_file(h, os.path.join(HERE, "icon.png"), "image/png", "max-age=86400")
        return True
    if path == "/manifest.json":
        _send_json(h, 200, {
            "name": "Music AI", "short_name": "Music AI", "display": "standalone", "start_url": "/",
            "background_color": "#000000", "theme_color": "#000000",
            "icons": [{"src": "/icon.png", "sizes": "512x512", "type": "image/png"}],
        })
        return True
    if path == "/api/search":
        try:
            _send_json(h, 200, {"songs": search(urllib.parse.unquote_plus(params.get("q", "")))})
        except Exception as exc:
            _send_json(h, 502, {"error": str(exc)[:300]})
        return True
    if path == "/api/upnext":
        try:
            _send_json(h, 200, {"songs": upnext(params.get("id", ""))})
        except Exception as exc:
            _send_json(h, 502, {"error": str(exc)[:300]})
        return True
    if path == "/api/diag":
        kept, used = clean_cache()
        _send_json(h, 200, {**_diag, "cached_songs": kept, "cache_mb": used, "cache_max_mb": CACHE_MAX_MB, "token_helper": POT_URL or "not set"})
        return True
    if path.startswith("/audio/"):
        song_id = path[len("/audio/"):]
        if not ID_RE.match(song_id):
            _send_json(h, 400, {"error": "bad id"})
            return True
        try:
            file_path = song_file(song_id)
        except Exception as exc:
            _send_json(h, 502, {"error": str(exc)[:400]})
            return True
        # Count a play once per song start (the first request, not every seek).
        rng = h.headers.get("Range") or ""
        if not rng or rng.startswith("bytes=0-"):
            _note_play(song_id)
        _send_file(h, file_path, "audio/mp4", "private, max-age=3600")
        return True
    return False


def start_background():
    def loop():
        while True:
            try:
                clean_cache()
            except Exception as exc:
                print(f"[cache] clean failed: {exc}", flush=True)
            time.sleep(3600)

    threading.Thread(target=loop, daemon=True).start()
