"""
Music AI taste server — runs on Storm's Umbrel (Raspberry Pi 5).

The phone app sends what you listen to (complete / skip / like / unlike).
This server learns your taste from it and, when your playlist ends,
ranks the candidate songs the app found so the best ones play next.

Model: every song, artist, album and title word gets a learned score.
Recent listens count more than old ones (half-life, default 14 days), so the
model follows your taste when it changes. It retrains every night and after
every batch of new events. No extra packages needed: pure Python + SQLite.
"""

import json
import math
import os
import random
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "8765"))
HALF_LIFE_DAYS = float(os.environ.get("HALF_LIFE_DAYS", "14"))
RETRAIN_EVERY = int(os.environ.get("RETRAIN_EVERY", "25"))
NIGHTLY_HOUR = int(os.environ.get("NIGHTLY_HOUR", "4"))
MIN_EVENTS_TRAINED = 20
MAX_PER_ARTIST = 2

LABELS = {"like": 2.0, "complete": 1.0, "skip": -1.0, "unlike": -2.0}
FEATURE_WEIGHTS = {"song": 1.0, "artist": 0.8, "album": 0.4, "word": 0.25}
STOPWORDS = set(
    "the a an and or of to in on for with feat ft official video audio lyrics lyric "
    "remaster remastered version edit mix remix live de het een en van".split()
)

os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "taste.db")
MODEL_PATH = os.path.join(DATA_DIR, "model.json")

db_lock = threading.Lock()
model_lock = threading.Lock()
model = {"weights": {}, "trained_at": 0, "events": 0}
new_events_since_train = 0


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            track_id TEXT NOT NULL,
            title TEXT,
            artists TEXT,
            album TEXT,
            duration INTEGER,
            listened_ms INTEGER,
            ts INTEGER NOT NULL,
            UNIQUE(type, track_id, ts)
        )"""
    )
    return conn


def words(title):
    title = re.sub(r"[\(\)\[\]\-–|,.!?\"'/:]", " ", (title or "").lower())
    return [w for w in title.split() if len(w) > 2 and w not in STOPWORDS]


def features(track):
    feats = [("song", track.get("id", ""))]
    for a in track.get("artists") or []:
        feats.append(("artist", a.lower()))
    if track.get("album"):
        feats.append(("album", track["album"].lower()))
    for w in set(words(track.get("title"))):
        feats.append(("word", w))
    return [f"{kind}:{value}" for kind, value in feats if value]


def label_for(event_type, listened_ms, duration):
    label = LABELS.get(event_type, 0.0)
    # A skip within 30 seconds is a clearer "no" than a skip halfway through.
    if event_type == "skip" and listened_ms is not None and listened_ms < 30_000:
        label = -1.5
    return label


def train():
    global new_events_since_train
    now_ms = time.time() * 1000
    half_life_ms = HALF_LIFE_DAYS * 86_400_000
    sums, counts = {}, {}
    with db_lock:
        conn = db()
        rows = conn.execute(
            "SELECT type, track_id, title, artists, album, duration, listened_ms, ts FROM events"
        ).fetchall()
        conn.close()
    for etype, tid, title, artists, album, duration, listened, ts in rows:
        decay = 0.5 ** (max(0.0, now_ms - ts) / half_life_ms)
        label = label_for(etype, listened, duration)
        track = {"id": tid, "title": title, "artists": json.loads(artists or "[]"), "album": album}
        for f in features(track):
            sums[f] = sums.get(f, 0.0) + label * decay
            counts[f] = counts.get(f, 0.0) + decay
    # Shrink towards 0 so one listen doesn't make a strong opinion.
    weights = {f: sums[f] / (counts[f] + 1.0) for f in sums}
    with model_lock:
        model["weights"] = weights
        model["trained_at"] = int(time.time())
        model["events"] = len(rows)
        with open(MODEL_PATH, "w") as fh:
            json.dump(model, fh)
    new_events_since_train = 0
    print(f"[train] {len(rows)} events, {len(weights)} features", flush=True)


def score(track, weights):
    total = 0.0
    for f in features(track):
        kind = f.split(":", 1)[0]
        w = weights.get(f)
        if w is not None:
            total += FEATURE_WEIGHTS[kind] * w
    return total


def rank(candidates, recent, count):
    with model_lock:
        weights = model["weights"]
        trained = model["events"] >= MIN_EVENTS_TRAINED
    recent = set(recent or [])
    scored = []
    for i, track in enumerate(candidates):
        if track.get("id") in recent:
            continue
        if trained:
            # Small random bonus so you still discover new things.
            s = score(track, weights) + random.uniform(0, 0.15)
        else:
            s = -i  # not enough data yet: keep YouTube's order
        scored.append((s, track))
    scored.sort(key=lambda x: x[0], reverse=True)

    picked, per_artist = [], {}
    for s, track in scored:
        main_artist = (track.get("artists") or ["?"])[0].lower()
        if per_artist.get(main_artist, 0) >= MAX_PER_ARTIST:
            continue
        # Never pick songs you clearly dislike.
        if trained and s < -0.6:
            continue
        per_artist[main_artist] = per_artist.get(main_artist, 0) + 1
        picked.append(track["id"])
        if len(picked) >= count:
            break
    return picked


def add_events(events):
    global new_events_since_train
    added = 0
    with db_lock:
        conn = db()
        for e in events:
            t = e.get("track") or {}
            if e.get("type") not in LABELS or not t.get("id"):
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO events (type, track_id, title, artists, album, duration, listened_ms, ts) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    e["type"],
                    t["id"],
                    t.get("title"),
                    json.dumps(t.get("artists") or []),
                    t.get("album"),
                    int(t.get("duration") or 0),
                    int(e.get("listenedMs") or 0),
                    int(e.get("ts") or time.time() * 1000),
                ),
            )
            added += cur.rowcount
        conn.commit()
        conn.close()
    new_events_since_train += added
    if new_events_since_train >= RETRAIN_EVERY:
        threading.Thread(target=train, daemon=True).start()
    return added


def stats():
    with model_lock:
        weights = dict(model["weights"])
        info = {"events": model["events"], "trained_at": model["trained_at"]}

    def top(prefix, reverse=True, n=10):
        items = [(k.split(":", 1)[1], round(v, 2)) for k, v in weights.items() if k.startswith(prefix)]
        return sorted(items, key=lambda x: x[1], reverse=reverse)[:n]

    info["favourite_artists"] = top("artist:")
    info["least_favourite_artists"] = top("artist:", reverse=False)
    info["favourite_words"] = top("word:")
    return info


def nightly_loop():
    last_day = None
    while True:
        now = time.localtime()
        if now.tm_hour == NIGHTLY_HOUR and last_day != now.tm_yday:
            last_day = now.tm_yday
            try:
                train()
            except Exception as exc:  # keep the loop alive
                print(f"[train] failed: {exc}", flush=True)
        time.sleep(300)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 5_000_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/health":
            with model_lock:
                self._send(200, {"ok": True, "events": model["events"], "trained": model["events"] >= MIN_EVENTS_TRAINED})
        elif self.path == "/stats":
            self._send(200, stats())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            data = self._read_json()
        except Exception:
            self._send(400, {"error": "bad json"})
            return
        if self.path == "/events":
            self._send(200, {"added": add_events(data.get("events") or [])})
        elif self.path == "/rank":
            ids = rank(data.get("candidates") or [], data.get("recent") or [], int(data.get("count") or 10))
            self._send(200, {"ids": ids})
        elif self.path == "/train":
            train()
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    if os.path.exists(MODEL_PATH):
        with open(MODEL_PATH) as fh:
            model.update(json.load(fh))
    train()
    threading.Thread(target=nightly_loop, daemon=True).start()
    print(f"Music AI taste server on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
