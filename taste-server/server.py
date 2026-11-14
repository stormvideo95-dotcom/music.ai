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
import secrets
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
MIN_MIX_SONGS = 10       # liked songs needed before AI mixes appear
MAX_MIXES = 4
SESSION_GAP_MS = 45 * 60 * 1000

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
model = {"weights": {}, "trained_at": 0, "events": 0, "clusters": []}
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
    clusters = build_clusters(rows, weights)
    with model_lock:
        model["weights"] = weights
        model["clusters"] = clusters
        model["trained_at"] = int(time.time())
        model["events"] = len(rows)
        with open(MODEL_PATH, "w") as fh:
            json.dump(model, fh)
    new_events_since_train = 0
    print(f"[train] {len(rows)} events, {len(weights)} features, {len(clusters)} groups", flush=True)


# ---------- Devices: pairing, now playing, "play on" commands ----------

PAIR_CODE_TTL = 10 * 60
ONLINE_WINDOW = 45  # seconds since last heartbeat to count as online
devices_lock = threading.Condition()
pair_requests = {}  # pairId -> {code, name, type, created, token}
command_queues = {}  # deviceId -> [commands]


def devices_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            name TEXT,
            type TEXT,
            created INTEGER,
            last_seen INTEGER,
            state TEXT
        )"""
    )
    return conn


def device_count():
    with db_lock:
        conn = devices_db()
        n = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
        conn.close()
    return n


def create_device(name, dtype):
    device_id = secrets.token_hex(6)
    token = secrets.token_urlsafe(24)
    with db_lock:
        conn = devices_db()
        conn.execute(
            "INSERT INTO devices (id, token, name, type, created, last_seen, state) VALUES (?,?,?,?,?,?,?)",
            (device_id, token, (name or "Device")[:40], (dtype or "other")[:20], int(time.time()), int(time.time()), "{}"),
        )
        conn.commit()
        conn.close()
    return device_id, token


def device_for_token(token):
    if not token:
        return None
    with db_lock:
        conn = devices_db()
        row = conn.execute("SELECT id, name, type FROM devices WHERE token = ?", (token,)).fetchone()
        conn.close()
    return {"id": row[0], "name": row[1], "type": row[2]} if row else None


def touch_device(device_id, state=None):
    with db_lock:
        conn = devices_db()
        if state is None:
            conn.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (int(time.time()), device_id))
        else:
            conn.execute(
                "UPDATE devices SET last_seen = ?, state = ? WHERE id = ?",
                (int(time.time()), json.dumps(state)[:20000], device_id),
            )
        conn.commit()
        conn.close()


def list_devices(me):
    now = int(time.time())
    with db_lock:
        conn = devices_db()
        rows = conn.execute("SELECT id, name, type, last_seen, state FROM devices ORDER BY created").fetchall()
        conn.close()
    return [
        {
            "id": r[0],
            "name": r[1],
            "type": r[2],
            "me": r[0] == me,
            "online": now - (r[3] or 0) <= ONLINE_WINDOW,
            "lastSeen": r[3],
            "state": json.loads(r[4] or "{}"),
        }
        for r in rows
    ]


def remove_device(device_id):
    with db_lock:
        conn = devices_db()
        conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        conn.commit()
        conn.close()


def pair_start(name, dtype):
    """New device asks to join. The very first device is trusted right away."""
    now = time.time()
    with devices_lock:
        for pid in [p for p, r in pair_requests.items() if now - r["created"] > PAIR_CODE_TTL]:
            del pair_requests[pid]
        if device_count() == 0:
            device_id, token = create_device(name, dtype)
            return {"approved": True, "token": token, "deviceId": device_id}
        used = {r["code"] for r in pair_requests.values()}
        code = f"{secrets.randbelow(1_000_000):06d}"
        while code in used:
            code = f"{secrets.randbelow(1_000_000):06d}"
        pair_id = secrets.token_urlsafe(12)
        pair_requests[pair_id] = {"code": code, "name": name, "type": dtype, "created": now, "token": None, "deviceId": None}
        return {"approved": False, "code": code, "pairId": pair_id, "expiresIn": PAIR_CODE_TTL}


def pair_approve(code):
    code = (code or "").strip().replace(" ", "")
    now = time.time()
    with devices_lock:
        for r in pair_requests.values():
            if r["code"] == code and r["token"] is None and now - r["created"] <= PAIR_CODE_TTL:
                r["deviceId"], r["token"] = create_device(r["name"], r["type"])
                devices_lock.notify_all()
                return {"approved": True, "name": r["name"]}
    return None


def pair_status(pair_id):
    with devices_lock:
        r = pair_requests.get(pair_id)
        if not r:
            return {"approved": False, "expired": True}
        if r["token"]:
            del pair_requests[pair_id]
            return {"approved": True, "token": r["token"], "deviceId": r["deviceId"]}
        return {"approved": False, "expired": False}


def push_command(target_id, command):
    with devices_lock:
        command_queues.setdefault(target_id, []).append(command)
        devices_lock.notify_all()


def wait_commands(device_id, timeout):
    deadline = time.time() + timeout
    with devices_lock:
        while not command_queues.get(device_id):
            left = deadline - time.time()
            if left <= 0:
                return []
            devices_lock.wait(left)
        return command_queues.pop(device_id, [])


# ---------- Taste groups (AI mixes) ----------

def build_clusters(rows, weights):
    """Split the songs you like into 2-4 groups of music you play together."""
    songs = {}
    for etype, tid, title, artists, album, duration, listened, ts in rows:
        songs[tid] = {
            "id": tid,
            "title": title or "",
            "artists": json.loads(artists or "[]"),
            "album": album,
            "duration": duration or 0,
        }
    liked = [t for t in songs if weights.get(f"song:{t}", 0) > 0.2]
    liked.sort(key=lambda t: weights[f"song:{t}"], reverse=True)
    liked = liked[:400]
    if len(liked) < MIN_MIX_SONGS:
        return []

    # Songs played close together in the same session belong together.
    co = {}
    positive = sorted((r for r in rows if r[0] in ("complete", "like")), key=lambda r: r[7])
    session, last_ts = [], None
    for r in positive + [None]:
        if r is None or (last_ts is not None and r[7] - last_ts > SESSION_GAP_MS):
            for i, a in enumerate(session):
                for b in session[i + 1 : i + 5]:
                    if a != b:
                        key = (a, b) if a < b else (b, a)
                        co[key] = co.get(key, 0) + 1
            session = []
        if r is not None:
            session.append(r[1])
            last_ts = r[7]

    info = {
        t: (
            {a.lower() for a in songs[t]["artists"]},
            set(words(songs[t]["title"])),
        )
        for t in liked
    }

    def sim(a, b):
        if a == b:
            return 3.0
        artists_a, words_a = info[a]
        artists_b, words_b = info[b]
        s = 1.0 if artists_a & artists_b else 0.0
        key = (a, b) if a < b else (b, a)
        s += min(co.get(key, 0), 3) * 0.5
        if words_a and words_b:
            s += 0.6 * len(words_a & words_b) / len(words_a | words_b)
        return s

    n = len(liked)
    S = [[sim(liked[i], liked[j]) for j in range(n)] for i in range(n)]

    def kmedoids(k):
        medoids = [0]
        while len(medoids) < k:
            far = min(range(n), key=lambda i: max(S[i][m] for m in medoids) if i not in medoids else 99)
            medoids.append(far)
        for _ in range(12):
            groups = [[] for _ in medoids]
            for i in range(n):
                groups[max(range(k), key=lambda g: S[i][medoids[g]])].append(i)
            new = [max(g, key=lambda c: sum(S[c][x] for x in g)) if g else medoids[gi] for gi, g in enumerate(groups)]
            if new == medoids:
                break
            medoids = new
        return groups

    def quality(groups):
        if any(len(g) < 4 for g in groups):
            return -99
        total = 0.0
        for gi, g in enumerate(groups):
            for i in g:
                inside = sum(S[i][x] for x in g if x != i) / max(1, len(g) - 1)
                outside = max(
                    sum(S[i][x] for x in h) / len(h) for hi, h in enumerate(groups) if hi != gi
                )
                total += inside - outside
        return total / n

    best, best_q = None, -99
    for k in range(2, MAX_MIXES + 1):
        if n < k * 4:
            break
        groups = kmedoids(k)
        q = quality(groups)
        if q > best_q:
            best, best_q = groups, q
    if not best:
        return []

    clusters, used_names = [], set()
    for g in best:
        ids = [liked[i] for i in g]
        ids.sort(key=lambda t: weights[f"song:{t}"], reverse=True)
        artist_count, word_count = {}, {}
        for t in ids:
            for a in info[t][0]:
                artist_count[a] = artist_count.get(a, 0) + 1
            for w in info[t][1]:
                word_count[w] = word_count.get(w, 0) + 1
        top_words = sorted(word_count.items(), key=lambda x: x[1], reverse=True)
        name = None
        if top_words and top_words[0][1] >= max(2, len(ids) * 0.3):
            name = top_words[0][0].capitalize()
        if not name or name.lower() in used_names:
            top_artist = max(artist_count.items(), key=lambda x: x[1])[0] if artist_count else "Mix"
            name = top_artist.title()
        if name.lower() in used_names:
            name = f"{name} {len(clusters) + 1}"
        used_names.add(name.lower())
        clusters.append(
            {
                "name": name,
                "ids": ids,
                "artists": artist_count,
                "words": dict(top_words[:20]),
                "songs": [songs[t] for t in ids[:50]],
            }
        )
    return clusters


def current_cluster(recent):
    """Which taste group are you listening to right now?"""
    with model_lock:
        clusters = model.get("clusters") or []
    if not clusters or not recent:
        return None
    votes = [0.0] * len(clusters)
    for pos, tid in enumerate(recent[-10:]):
        weight = 1.0 + pos * 0.2  # newest songs count most
        for ci, c in enumerate(clusters):
            if tid in c["ids"]:
                votes[ci] += weight
    best = max(range(len(clusters)), key=lambda i: votes[i])
    return clusters[best] if votes[best] > 0 else None


def group_bonus(track, cluster):
    if not cluster:
        return 0.0
    top = max(cluster["artists"].values()) if cluster["artists"] else 1
    artist_part = max((cluster["artists"].get(a.lower(), 0) / top for a in track.get("artists") or []), default=0)
    ws = set(words(track.get("title")))
    word_part = (len(ws & set(cluster["words"])) / len(ws)) if ws else 0
    if artist_part == 0 and word_part == 0:
        return -0.5  # different style than what you're listening to now
    return 0.6 + 0.6 * artist_part + 0.6 * word_part


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
    group = current_cluster(recent or [])
    recent = set(recent or [])
    scored = []
    for i, track in enumerate(candidates):
        if track.get("id") in recent:
            continue
        if trained:
            # Small random bonus so you still discover new things.
            s = score(track, weights) + group_bonus(track, group) + random.uniform(0, 0.15)
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


def current_likes():
    """Songs whose latest like/unlike is a like (from any device), newest first."""
    with db_lock:
        conn = db()
        rows = conn.execute(
            """SELECT e.track_id, e.title, e.artists, e.album, e.duration, e.type, e.ts FROM events e
               JOIN (SELECT track_id, MAX(ts) AS ts FROM events WHERE type IN ('like','unlike') GROUP BY track_id) last
               ON e.track_id = last.track_id AND e.ts = last.ts
               WHERE e.type IN ('like','unlike')
               ORDER BY e.ts DESC"""
        ).fetchall()
        conn.close()
    seen, out, unliked = set(), [], []
    for tid, title, artists, album, duration, etype, ts in rows:
        if tid in seen:
            continue
        seen.add(tid)
        if etype == "like":
            out.append({"id": tid, "title": title, "artists": json.loads(artists or "[]"), "album": album, "duration": duration, "likedAt": ts})
        else:
            unliked.append({"id": tid, "at": ts})
    return out, unliked


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
    with model_lock:
        info["groups"] = [{"name": c["name"], "songs": len(c["ids"])} for c in model.get("clusters") or []]
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

    def _device(self):
        dev = device_for_token(self.headers.get("X-Device-Token"))
        if not dev:
            self._send(401, {"error": "not paired"})
        return dev

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        if path == "/pair/status":
            self._send(200, pair_status(params.get("pairId", "")))
            return
        if path == "/sync/devices":
            dev = self._device()
            if dev:
                touch_device(dev["id"])
                self._send(200, {"me": dev["id"], "devices": list_devices(dev["id"])})
            return
        if path == "/sync/commands":
            dev = self._device()
            if dev:
                touch_device(dev["id"])
                timeout = min(25.0, max(0.0, float(params.get("wait", "20"))))
                self._send(200, {"commands": wait_commands(dev["id"], timeout)})
            return
        if self.path == "/health":
            with model_lock:
                self._send(200, {"ok": True, "events": model["events"], "trained": model["events"] >= MIN_EVENTS_TRAINED})
        elif self.path == "/mixes":
            with model_lock:
                clusters = model.get("clusters") or []
                liked = sum(1 for k, v in model["weights"].items() if k.startswith("song:") and v > 0.2)
            self._send(
                200,
                {
                    "ready": bool(clusters),
                    "likedSongs": liked,
                    "needed": MIN_MIX_SONGS,
                    "mixes": [{"name": c["name"], "songs": c["songs"]} for c in clusters],
                },
            )
        elif self.path == "/likes":
            likes, unliked = current_likes()
            self._send(200, {"likes": likes, "unliked": unliked})
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
        elif self.path == "/pair/start":
            self._send(200, pair_start(str(data.get("name") or "Device"), str(data.get("type") or "other")))
        elif self.path == "/pair/approve":
            if self._device():
                result = pair_approve(str(data.get("code") or ""))
                self._send(200 if result else 404, result or {"error": "wrong or expired code"})
        elif self.path == "/sync/state":
            dev = self._device()
            if dev:
                touch_device(dev["id"], data.get("state") or {})
                self._send(200, {"ok": True})
        elif self.path == "/sync/command":
            dev = self._device()
            if dev:
                target = str(data.get("target") or "")
                if not any(d["id"] == target for d in list_devices(dev["id"])):
                    self._send(404, {"error": "unknown device"})
                    return
                command = data.get("command") or {}
                command["from"] = dev["name"]
                command["ts"] = int(time.time() * 1000)
                push_command(target, command)
                self._send(200, {"ok": True})
        elif self.path == "/sync/unpair":
            dev = self._device()
            if dev:
                remove_device(str(data.get("deviceId") or dev["id"]))
                self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    devices_db().close()
    if os.path.exists(MODEL_PATH):
        with open(MODEL_PATH) as fh:
            model.update(json.load(fh))
    train()
    threading.Thread(target=nightly_loop, daemon=True).start()
    print(f"Music AI taste server on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
