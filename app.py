import os
import json
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict
from urllib.parse import urlencode
from contextlib import contextmanager

import requests
import psycopg2
import psycopg2.extras
from flask import Flask, redirect, request, session, jsonify, render_template, make_response
from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
import atexit

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-in-production")

CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", "http://localhost:5000/callback").strip()
DATABASE_URL = os.getenv("DATABASE_URL", "")
ADMIN_USER_ID = "31auxhnhp5cqfegpytr3qxeisdbm"

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"

SCOPES = "user-read-recently-played user-top-read user-read-playback-state user-library-read"


# ── Database helpers ──────────────────────────────────────────────────────────

@contextmanager
def get_db():
    """Yields a psycopg2 connection. Auto-commits on success, rolls back on error.
    Yields None gracefully if DATABASE_URL is not configured."""
    if not DATABASE_URL:
        yield None
        return
    # Don't duplicate sslmode if already in the URL (Neon/Supabase include it)
    if "sslmode=" in DATABASE_URL:
        conn = psycopg2.connect(DATABASE_URL)
    else:
        conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create tables if they don't exist. Idempotent — safe to call every startup."""
    if not DATABASE_URL:
        print("=" * 60)
        print("WARNING: DATABASE_URL is not set.")
        print("Other users will NOT be saved and sync will fail.")
        print("Set DATABASE_URL in your environment or .env file.")
        print("=" * 60)
        return
    try:
        with get_db() as conn:
            if conn is None:
                return
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    spotify_id    TEXT PRIMARY KEY,
                    display_name  TEXT,
                    refresh_token TEXT NOT NULL,
                    created_at    TIMESTAMPTZ DEFAULT NOW(),
                    updated_at    TIMESTAMPTZ DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS play_history (
                    id              SERIAL PRIMARY KEY,
                    spotify_user_id TEXT NOT NULL REFERENCES users(spotify_id) ON DELETE CASCADE,
                    track_id        TEXT NOT NULL,
                    track_name      TEXT NOT NULL,
                    artist_name     TEXT NOT NULL,
                    album_name      TEXT NOT NULL,
                    played_at       TIMESTAMPTZ NOT NULL,
                    UNIQUE (spotify_user_id, played_at)
                );
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_play_history_user_played
                ON play_history (spotify_user_id, played_at DESC);
            """)
            print("DB tables ready.")
    except Exception as e:
        print(f"WARNING: DB init failed — {e}")


def upsert_user(conn, spotify_id, display_name, refresh_token):
    """Insert or update a user row with the latest refresh_token."""
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO users (spotify_id, display_name, refresh_token, updated_at)
        VALUES (%s, %s, %s, NOW())
        ON CONFLICT (spotify_id) DO UPDATE
            SET display_name  = EXCLUDED.display_name,
                refresh_token = EXCLUDED.refresh_token,
                updated_at    = NOW();
    """, (spotify_id, display_name or spotify_id, refresh_token))


def sync_recent_tracks(spotify_user_id, access_token):
    """Fetch recent plays from Spotify and insert any new ones into play_history.
    Uses the 'after' cursor to only fetch tracks newer than what we already have,
    and paginates to capture up to 250 tracks per sync.
    Deduplication is handled by UNIQUE(spotify_user_id, played_at) constraint.
    Returns the count of newly inserted rows."""
    if not DATABASE_URL:
        return 0

    # Find the timestamp of the newest track we already have for this user
    after_ms = None
    try:
        with get_db() as conn:
            if conn:
                cur = conn.cursor()
                cur.execute(
                    "SELECT MAX(played_at) FROM play_history WHERE spotify_user_id = %s",
                    (spotify_user_id,)
                )
                row = cur.fetchone()
                if row and row[0]:
                    # Spotify wants Unix milliseconds for the 'after' parameter
                    after_ms = int(row[0].timestamp() * 1000)
    except Exception:
        pass

    # Fetch up to 5 pages (250 tracks max) starting from our last known track
    all_rows = []
    params = {"limit": 50}
    if after_ms:
        params["after"] = after_ms

    for page in range(5):
        try:
            data = spotify_get("/me/player/recently-played", access_token, params=params)
        except Exception:
            break

        items = data.get("items", [])
        if not items:
            break

        for item in items:
            t = item["track"]
            all_rows.append((
                spotify_user_id,
                t["id"],
                t["name"],
                ", ".join(a["name"] for a in t["artists"]),
                t["album"]["name"],
                item["played_at"],
            ))

        # Check if there are more pages (use 'before' cursor to go further back)
        cursors = data.get("cursors") or {}
        before_cursor = cursors.get("before")
        if not before_cursor or len(items) < 50:
            break  # No more pages
        params = {"limit": 50, "before": before_cursor}

    if not all_rows:
        return 0

    inserted = 0
    try:
        with get_db() as conn:
            if conn is None:
                return 0
            cur = conn.cursor()
            for row in all_rows:
                cur.execute("""
                    INSERT INTO play_history
                        (spotify_user_id, track_id, track_name, artist_name, album_name, played_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (spotify_user_id, played_at) DO NOTHING;
                """, row)
                inserted += cur.rowcount
    except Exception as e:
        print(f"sync_recent_tracks error: {e}")
    return inserted


def get_or_set_user_id(token):
    """Return the Spotify user ID from session, fetching from /me if not cached."""
    uid = session.get("spotify_user_id")
    if uid:
        return uid
    try:
        profile = spotify_get("/me", token)
        uid = profile["id"]
        session["spotify_user_id"] = uid
    except Exception as e:
        print(f"get_or_set_user_id failed: {e}")
        uid = None
    return uid


# Call once at startup to ensure tables exist
init_db()


# ── Spotify helpers ───────────────────────────────────────────────────────────

class SpotifyForbiddenError(Exception):
    """Raised when Spotify returns 403 (deprecated endpoint or user not authorized)."""
    pass


def spotify_get(endpoint, token, params=None):
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(f"{API_BASE}{endpoint}", headers=headers, params=params)
    if resp.status_code == 403:
        raise SpotifyForbiddenError(f"403 Forbidden on {endpoint} — user may not be added as tester in Spotify Dashboard")
    resp.raise_for_status()
    return resp.json()


def refresh_access_token():
    refresh_token = session.get("refresh_token")
    if not refresh_token:
        return None
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    })
    data = resp.json()
    if "access_token" in data:
        session["access_token"] = data["access_token"]
        session["token_expiry"] = time.time() + data.get("expires_in", 3600)
        # If Spotify rotated the refresh token, update DB
        new_refresh = data.get("refresh_token")
        if new_refresh and new_refresh != refresh_token:
            session["refresh_token"] = new_refresh
            uid = session.get("spotify_user_id")
            if uid and DATABASE_URL:
                try:
                    with get_db() as conn:
                        if conn:
                            upsert_user(conn, uid, None, new_refresh)
                except Exception:
                    pass
        return data["access_token"]
    return None


def get_valid_token():
    if time.time() > session.get("token_expiry", 0) - 60:
        return refresh_access_token()
    return session.get("access_token")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/debug")
def debug():
    return jsonify({
        "REDIRECT_URI": REDIRECT_URI,
        "CLIENT_ID": CLIENT_ID[:8] + "..." if CLIENT_ID else "MISSING",
        "DATABASE_URL": "configured" if DATABASE_URL else "NOT SET",
        "session_user_id": session.get("spotify_user_id", "NOT SET"),
        "has_token": bool(session.get("access_token")),
        "has_refresh": bool(session.get("refresh_token")),
    })


@app.route("/")
def index():
    # Fast path: session is valid
    if "access_token" in session:
        return render_template("index.html", logged_in=True, db_configured=bool(DATABASE_URL))

    # Slow path: try to restore session from DB using the long-lived ma_uid cookie
    if DATABASE_URL:
        user_id_cookie = request.cookies.get("ma_uid")
        if user_id_cookie:
            try:
                with get_db() as conn:
                    if conn:
                        cur = conn.cursor()
                        cur.execute(
                            "SELECT refresh_token FROM users WHERE spotify_id = %s",
                            (user_id_cookie,)
                        )
                        row = cur.fetchone()
                        if row:
                            stored_refresh = row[0]
                            resp = requests.post(TOKEN_URL, data={
                                "grant_type": "refresh_token",
                                "refresh_token": stored_refresh,
                                "client_id": CLIENT_ID,
                                "client_secret": CLIENT_SECRET,
                            })
                            token_data = resp.json()
                            if "access_token" in token_data:
                                session["access_token"] = token_data["access_token"]
                                session["refresh_token"] = stored_refresh
                                session["token_expiry"] = time.time() + token_data.get("expires_in", 3600)
                                session["spotify_user_id"] = user_id_cookie
                                # Update DB if Spotify rotated the refresh token
                                new_refresh = token_data.get("refresh_token")
                                if new_refresh and new_refresh != stored_refresh:
                                    with get_db() as conn2:
                                        if conn2:
                                            upsert_user(conn2, user_id_cookie, None, new_refresh)
                                return render_template("index.html", logged_in=True)
            except Exception as e:
                print(f"Auto-restore failed (non-fatal): {e}")

    return render_template("index.html", logged_in=False, db_configured=bool(DATABASE_URL))


@app.route("/login")
def login():
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "show_dialog": "true",
    }
    return redirect(f"{AUTH_URL}?{urlencode(params)}")


@app.route("/callback")
def callback():
    code = request.args.get("code")
    error = request.args.get("error")
    if error or not code:
        return f"Auth error: {error}", 400

    resp = requests.post(TOKEN_URL, data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    })
    data = resp.json()
    access_token = data["access_token"]
    refresh_token = data.get("refresh_token", "")

    session["access_token"] = access_token
    session["refresh_token"] = refresh_token
    session["token_expiry"] = time.time() + data.get("expires_in", 3600)

    # Fetch Spotify profile — always do this (sets session user ID)
    spotify_id = None
    try:
        profile = spotify_get("/me", access_token)
        spotify_id = profile["id"]
        display_name = profile.get("display_name") or spotify_id
        session["spotify_user_id"] = spotify_id
    except Exception as e:
        print(f"WARNING: /me call failed for user: {e}")

    # Persist user to DB (even if Spotify data endpoints return 403)
    if spotify_id and DATABASE_URL:
        try:
            with get_db() as conn:
                if conn:
                    upsert_user(conn, spotify_id, display_name, refresh_token)
        except Exception as e:
            print(f"DB upsert failed (non-fatal): {e}")
        # Sync play history separately — may fail with 403 for non-tester users
        try:
            sync_recent_tracks(spotify_id, access_token)
        except Exception as e:
            print(f"Initial sync failed for {spotify_id} (non-fatal): {e}")

    response = make_response(redirect("/"))
    if spotify_id:
        # Long-lived cookie (1 year) with just the public Spotify user ID — not a secret
        response.set_cookie("ma_uid", spotify_id, max_age=365 * 24 * 3600, httponly=True, samesite="Lax")
    return response


@app.route("/logout")
def logout():
    session.clear()
    response = make_response(redirect("/"))
    response.delete_cookie("ma_uid")
    return response


# ── API endpoints ─────────────────────────────────────────────────────────────

def is_admin():
    return session.get("spotify_user_id") == ADMIN_USER_ID


@app.route("/api/profile")
def api_profile():
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    data = spotify_get("/me", token)
    data["is_admin"] = is_admin()
    return jsonify(data)


@app.route("/api/recent")
def api_recent():
    """Returns last 50 recently played tracks with timestamps."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    try:
        data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    except SpotifyForbiddenError:
        return jsonify({"error": "forbidden", "msg": "Spotify denied access — user must be added as tester in the Spotify Developer Dashboard"}), 403
    return jsonify(data)


@app.route("/api/sync")
def api_sync():
    """Manual sync: fetch recent plays from Spotify and save new ones to DB."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated", "msg": "Please log out and log in again"}), 401

    if not DATABASE_URL:
        return jsonify({"error": "no_database", "msg": "Database not configured on server"}), 400

    # Get or fetch the Spotify user ID
    spotify_user_id = session.get("spotify_user_id")
    if not spotify_user_id:
        # Try to fetch it from Spotify directly
        try:
            profile = spotify_get("/me", token)
            spotify_user_id = profile["id"]
            session["spotify_user_id"] = spotify_user_id
        except Exception as e:
            return jsonify({"error": "spotify_api", "msg": f"Spotify API error: {e}"}), 502

    # Ensure user row exists in DB (handles first-time users and users missed by callback)
    try:
        profile = spotify_get("/me", token)
        display_name = profile.get("display_name") or spotify_user_id
        with get_db() as conn:
            if conn:
                upsert_user(conn, spotify_user_id, display_name, session.get("refresh_token", ""))
    except Exception as e:
        return jsonify({"error": "db_connection", "msg": f"Database error: {e}"}), 500

    new_count = sync_recent_tracks(spotify_user_id, token)

    total = 0
    try:
        with get_db() as conn:
            if conn:
                cur = conn.cursor()
                cur.execute(
                    "SELECT COUNT(*) FROM play_history WHERE spotify_user_id = %s",
                    (spotify_user_id,)
                )
                total = cur.fetchone()[0]
    except Exception as e:
        return jsonify({"error": "db_query", "msg": f"Count query failed: {e}"}), 500

    return jsonify({"new_tracks": new_count, "total_stored": total})


@app.route("/api/weekly_heatmap")
def api_weekly_heatmap():
    """
    Returns a 7×24 grid (day × hour) of play counts.
    Uses full DB history if available; falls back to last 50 Spotify plays.
    day: 0=Monday … 6=Sunday, hour: 0-23
    """
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    # Use client timezone for correct day/hour bucketing
    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    spotify_user_id = get_or_set_user_id(token)
    grid = defaultdict(int)
    tracks_by_slot = defaultdict(list)

    if DATABASE_URL and spotify_user_id:
        # Sync latest plays, then query full history
        sync_recent_tracks(spotify_user_id, token)
        try:
            with get_db() as conn:
                if conn:
                    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                    cur.execute("""
                        SELECT track_name, played_at
                        FROM play_history
                        WHERE spotify_user_id = %s
                        ORDER BY played_at DESC;
                    """, (spotify_user_id,))
                    for row in cur.fetchall():
                        dt = row["played_at"]   # psycopg2 returns a datetime object
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        dt = dt.astimezone(user_tz)
                        day = dt.weekday()
                        hour = dt.hour
                        grid[(day, hour)] += 1
                        tracks_by_slot[(day, hour)].append(row["track_name"])
        except Exception as e:
            print(f"Heatmap DB query failed, falling back: {e}")
            grid.clear()
            tracks_by_slot.clear()

    if not grid:
        # Fallback: original Spotify-only path
        try:
            data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
            for item in data.get("items", []):
                dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
                dt = dt.replace(tzinfo=timezone.utc).astimezone(user_tz)
                day = dt.weekday()
                hour = dt.hour
                grid[(day, hour)] += 1
                tracks_by_slot[(day, hour)].append(item["track"]["name"])
        except SpotifyForbiddenError:
            pass  # Return empty grid

    result = []
    for (day, hour), count in grid.items():
        result.append({
            "day": day,
            "hour": hour,
            "count": count,
            "tracks": tracks_by_slot[(day, hour)][:3],
        })
    return jsonify(result)


@app.route("/api/top_tracks")
def api_top_tracks():
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    term = request.args.get("time_range", "short_term")
    data = spotify_get("/me/top/tracks", token, params={"limit": 10, "time_range": term})
    tracks = []
    for item in data.get("items", []):
        tracks.append({
            "name": item["name"],
            "artist": ", ".join(a["name"] for a in item["artists"]),
            "album": item["album"]["name"],
            "image": item["album"]["images"][0]["url"] if item["album"]["images"] else None,
            "popularity": item["popularity"],
            "id": item["id"],
        })
    return jsonify(tracks)


@app.route("/api/top_artists")
def api_top_artists():
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    term = request.args.get("time_range", "short_term")
    data = spotify_get("/me/top/artists", token, params={"limit": 10, "time_range": term})
    artists = []
    for item in data.get("items", []):
        artists.append({
            "name": item["name"],
            "genres": item["genres"][:3],
            "popularity": item["popularity"],
            "followers": item["followers"]["total"],
            "image": item["images"][0]["url"] if item["images"] else None,
        })
    return jsonify(artists)


@app.route("/api/audio_features")
def api_audio_features():
    """Average audio features for top 20 short-term tracks."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    top = spotify_get("/me/top/tracks", token, params={"limit": 20, "time_range": "short_term"})
    ids = [t["id"] for t in top.get("items", [])]
    if not ids:
        return jsonify({})

    try:
        feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
    except SpotifyForbiddenError:
        return jsonify({"error": "deprecated"}), 403

    features = feat_data.get("audio_features") or []
    valid = [f for f in features if f]

    if not valid:
        return jsonify({})

    keys = ["danceability", "energy", "speechiness", "acousticness",
            "instrumentalness", "liveness", "valence"]
    averages = {k: round(sum(f.get(k, 0) for f in valid) / len(valid), 3) for k in keys}
    avg_tempo = round(sum(f.get("tempo", 0) for f in valid) / len(valid), 1)
    averages["tempo_normalized"] = round(min(avg_tempo / 200, 1.0), 3)
    averages["tempo"] = avg_tempo
    return jsonify(averages)


@app.route("/api/genre_breakdown")
def api_genre_breakdown():
    """Genre distribution from top artists."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    term = request.args.get("time_range", "short_term")
    data = spotify_get("/me/top/artists", token, params={"limit": 20, "time_range": term})
    genre_count = defaultdict(int)
    for artist in data.get("items", []):
        for g in artist["genres"]:
            genre_count[g] += 1

    sorted_genres = sorted(genre_count.items(), key=lambda x: x[1], reverse=True)
    return jsonify([{"genre": g, "count": c} for g, c in sorted_genres[:15]])


@app.route("/api/listening_streak")
def api_listening_streak():
    """Count distinct days listened. Uses full DB history if available."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    spotify_user_id = get_or_set_user_id(token)

    if DATABASE_URL and spotify_user_id:
        try:
            with get_db() as conn:
                if conn:
                    cur = conn.cursor()
                    cur.execute("""
                        SELECT DISTINCT (played_at AT TIME ZONE %s)::DATE AS play_date
                        FROM play_history
                        WHERE spotify_user_id = %s
                        ORDER BY play_date DESC;
                    """, (tz_name, spotify_user_id))
                    days = {row[0] for row in cur.fetchall()}

                    cur.execute(
                        "SELECT COUNT(*) FROM play_history WHERE spotify_user_id = %s",
                        (spotify_user_id,)
                    )
                    total_plays = cur.fetchone()[0]

            today = datetime.now(user_tz).date()
            streak = 0
            check = today
            while check in days:
                streak += 1
                check -= timedelta(days=1)

            return jsonify({
                "streak": streak,
                "active_days": len(days),
                "total_plays": total_plays,
            })
        except Exception as e:
            print(f"Streak DB query failed, falling back: {e}")

    # Fallback: original Spotify-only path
    try:
        data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    except SpotifyForbiddenError:
        return jsonify({"streak": 0, "active_days": 0, "total_plays": 0})
    days = set()
    for item in data.get("items", []):
        dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
        dt = dt.replace(tzinfo=timezone.utc).astimezone(user_tz)
        days.add(dt.date())
    today = datetime.now(user_tz).date()
    streak = 0
    check = today
    while check in days:
        streak += 1
        check -= timedelta(days=1)
    return jsonify({
        "streak": streak,
        "active_days": len(days),
        "total_plays": len(data.get("items", [])),
    })


@app.route("/api/listening_personality")
def api_listening_personality():
    """Classify user as Night Owl, Early Bird, etc. based on listening hours."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    spotify_user_id = get_or_set_user_id(token)
    hourly = [0] * 24

    if DATABASE_URL and spotify_user_id:
        try:
            with get_db() as conn:
                if conn:
                    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                    cur.execute("""
                        SELECT EXTRACT(HOUR FROM played_at AT TIME ZONE %s)::INT AS hour,
                               COUNT(*) AS cnt
                        FROM play_history
                        WHERE spotify_user_id = %s
                        GROUP BY hour ORDER BY hour
                    """, (tz_name, spotify_user_id))
                    for row in cur.fetchall():
                        hourly[row["hour"]] = row["cnt"]
        except Exception:
            pass

    # Fallback to Spotify
    if sum(hourly) == 0:
        try:
            data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
            for item in data.get("items", []):
                dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
                dt = dt.replace(tzinfo=timezone.utc).astimezone(user_tz)
                hourly[dt.hour] += 1
        except Exception:
            pass

    total = sum(hourly)
    if total == 0:
        return jsonify({"type": "Unknown", "emoji": "🎵", "desc": "Not enough data yet.", "blocks": {}, "hourly": hourly, "fun_stat": ""})

    blocks = {
        "Morning (5-11)": sum(hourly[5:12]),
        "Afternoon (12-16)": sum(hourly[12:17]),
        "Evening (17-21)": sum(hourly[17:22]),
        "Night (22-4)": sum(hourly[22:]) + sum(hourly[:5]),
    }

    dominant = max(blocks, key=blocks.get)
    pct = round(blocks[dominant] / total * 100)

    personalities = {
        "Morning (5-11)": ("Early Bird", "🐦", "You start your day with music! Your peak listening is in the morning hours."),
        "Afternoon (12-16)": ("Afternoon Listener", "☀️", "Your music peaks in the afternoon — the perfect midday soundtrack."),
        "Evening (17-21)": ("Evening Vibes", "🌆", "You wind down with music in the evening — golden hour, golden tunes."),
        "Night (22-4)": ("Night Owl", "🦉", "You come alive after dark — most of your listening happens late at night."),
    }

    ptype, emoji, desc = personalities[dominant]
    peak_hour = hourly.index(max(hourly))
    fun_stat = f"{pct}% of your listening happens during {dominant.lower()}. Peak hour: {peak_hour}:00"

    return jsonify({
        "type": ptype, "emoji": emoji, "desc": desc,
        "blocks": blocks, "hourly": hourly, "fun_stat": fun_stat,
    })


@app.route("/api/artist_flow")
def api_artist_flow():
    """Show how user transitions between artists in consecutive plays."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    if not DATABASE_URL:
        return jsonify({"transitions": [], "artists": []})

    spotify_user_id = get_or_set_user_id(token)
    if not spotify_user_id:
        return jsonify({"transitions": [], "artists": []})

    try:
        with get_db() as conn:
            if not conn:
                return jsonify({"transitions": [], "artists": []})
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT artist_name FROM play_history
                WHERE spotify_user_id = %s
                ORDER BY played_at ASC
            """, (spotify_user_id,))
            rows = cur.fetchall()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    transitions = defaultdict(int)
    artist_counts = defaultdict(int)
    prev_artist = None

    for row in rows:
        artist = row["artist_name"]
        artist_counts[artist] += 1
        if prev_artist and prev_artist != artist:
            transitions[(prev_artist, artist)] += 1
        prev_artist = artist

    sorted_trans = sorted(transitions.items(), key=lambda x: x[1], reverse=True)[:15]
    top_artists = sorted(artist_counts.items(), key=lambda x: x[1], reverse=True)[:10]

    return jsonify({
        "transitions": [{"from": k[0], "to": k[1], "count": v} for k, v in sorted_trans],
        "artists": [{"name": a, "count": c} for a, c in top_artists],
    })


@app.route("/api/discovery_rate")
def api_discovery_rate():
    """Track new vs replayed tracks per week over time."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    if not DATABASE_URL:
        return jsonify({"error": "no_database"}), 400

    tz_name = request.args.get("tz", "UTC")
    spotify_user_id = get_or_set_user_id(token)
    if not spotify_user_id:
        return jsonify({"error": "no_user"}), 400

    try:
        with get_db() as conn:
            if not conn:
                return jsonify({"error": "no_database"}), 400
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT track_id, artist_name,
                       DATE_TRUNC('week', played_at AT TIME ZONE %s)::DATE AS week_start
                FROM play_history
                WHERE spotify_user_id = %s
                ORDER BY played_at ASC
            """, (tz_name, spotify_user_id))
            rows = cur.fetchall()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    seen_tracks = set()
    seen_artists = set()
    weekly = defaultdict(lambda: {"new_tracks": 0, "replays": 0, "new_artists": 0, "total": 0})

    for row in rows:
        week = row["week_start"].isoformat()
        weekly[week]["total"] += 1

        if row["track_id"] not in seen_tracks:
            seen_tracks.add(row["track_id"])
            weekly[week]["new_tracks"] += 1
        else:
            weekly[week]["replays"] += 1

        if row["artist_name"] not in seen_artists:
            seen_artists.add(row["artist_name"])
            weekly[week]["new_artists"] += 1

    sorted_weeks = sorted(weekly.items())
    total_plays = sum(w["total"] for _, w in sorted_weeks)
    discovery_ratio = round(len(seen_tracks) / total_plays * 100) if total_plays else 0

    return jsonify({
        "weeks": [{"week": w, **data} for w, data in sorted_weeks],
        "stats": {
            "total_unique_tracks": len(seen_tracks),
            "total_unique_artists": len(seen_artists),
            "total_plays": total_plays,
            "discovery_ratio": discovery_ratio,
        }
    })


@app.route("/api/top_albums")
def api_top_albums():
    """Top albums from user's top tracks with cover art."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    data = spotify_get("/me/top/tracks", token, params={"limit": 50, "time_range": "short_term"})
    seen = set()
    albums = []
    for item in data.get("items", []):
        album = item["album"]
        album_id = album["id"]
        if album_id in seen:
            continue
        seen.add(album_id)
        if album.get("images"):
            albums.append({
                "id": album_id,
                "name": album["name"],
                "artist": ", ".join(a["name"] for a in item["artists"]),
                "image": album["images"][0]["url"],
            })
        if len(albums) >= 16:
            break

    return jsonify(albums)


@app.route("/api/most_played")
def api_most_played():
    """Top tracks by play count from the database."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    if not DATABASE_URL:
        return jsonify([])

    spotify_user_id = get_or_set_user_id(token)
    if not spotify_user_id:
        return jsonify([])

    limit = min(int(request.args.get("limit", 20)), 50)
    try:
        with get_db() as conn:
            if not conn:
                return jsonify([])
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT track_id, track_name, artist_name, album_name,
                       COUNT(*) AS play_count,
                       MAX(played_at) AS last_played
                FROM play_history
                WHERE spotify_user_id = %s
                GROUP BY track_id, track_name, artist_name, album_name
                ORDER BY play_count DESC
                LIMIT %s;
            """, (spotify_user_id, limit))
            rows = cur.fetchall()
            result = []
            for row in rows:
                result.append({
                    "track_id": row["track_id"],
                    "name": row["track_name"],
                    "artist": row["artist_name"],
                    "album": row["album_name"],
                    "play_count": row["play_count"],
                    "last_played": row["last_played"].isoformat() if row["last_played"] else None,
                })
            return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/milestones")
def api_milestones():
    """Listening milestones / achievements based on DB history."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    if not DATABASE_URL:
        return jsonify([])

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    spotify_user_id = get_or_set_user_id(token)
    if not spotify_user_id:
        return jsonify([])

    milestones = []
    try:
        with get_db() as conn:
            if not conn:
                return jsonify([])
            cur = conn.cursor()

            # Total plays
            cur.execute("SELECT COUNT(*) FROM play_history WHERE spotify_user_id = %s", (spotify_user_id,))
            total_plays = cur.fetchone()[0]

            play_thresholds = [
                (50, "First Steps", "Reached 50 plays", "👶"),
                (100, "Century Club", "Reached 100 plays", "💯"),
                (250, "Music Lover", "Reached 250 plays", "🎶"),
                (500, "Half K", "Reached 500 plays", "🔥"),
                (1000, "Thousand Vibes", "Reached 1,000 plays", "🏆"),
                (2500, "Audiophile", "Reached 2,500 plays", "🎧"),
                (5000, "Sound Master", "Reached 5,000 plays", "👑"),
            ]
            for threshold, title, desc, emoji in play_thresholds:
                milestones.append({
                    "title": title, "desc": desc, "emoji": emoji,
                    "target": threshold, "current": total_plays,
                    "unlocked": total_plays >= threshold,
                })

            # Unique artists listened to
            cur.execute("""
                SELECT COUNT(DISTINCT artist_name) FROM play_history
                WHERE spotify_user_id = %s
            """, (spotify_user_id,))
            unique_artists = cur.fetchone()[0]

            artist_thresholds = [
                (10, "Explorer", "Listened to 10 different artists", "🧭"),
                (25, "Genre Hopper", "Listened to 25 different artists", "🌍"),
                (50, "Music Nomad", "Listened to 50 different artists", "🗺️"),
                (100, "World Listener", "Listened to 100 different artists", "🌐"),
            ]
            for threshold, title, desc, emoji in artist_thresholds:
                milestones.append({
                    "title": title, "desc": desc, "emoji": emoji,
                    "target": threshold, "current": unique_artists,
                    "unlocked": unique_artists >= threshold,
                })

            # Unique tracks listened to
            cur.execute("""
                SELECT COUNT(DISTINCT track_id) FROM play_history
                WHERE spotify_user_id = %s
            """, (spotify_user_id,))
            unique_tracks = cur.fetchone()[0]

            track_thresholds = [
                (25, "Starter Kit", "Listened to 25 unique tracks", "🎵"),
                (50, "Growing Library", "Listened to 50 unique tracks", "📚"),
                (100, "Track Collector", "Listened to 100 unique tracks", "💿"),
                (250, "DJ Material", "Listened to 250 unique tracks", "🎛️"),
                (500, "Song Encyclopedia", "Listened to 500 unique tracks", "📖"),
            ]
            for threshold, title, desc, emoji in track_thresholds:
                milestones.append({
                    "title": title, "desc": desc, "emoji": emoji,
                    "target": threshold, "current": unique_tracks,
                    "unlocked": unique_tracks >= threshold,
                })

            # Listening streak (active days)
            cur.execute("""
                SELECT DISTINCT (played_at AT TIME ZONE %s)::DATE AS play_date
                FROM play_history WHERE spotify_user_id = %s
            """, (tz_name, spotify_user_id))
            days = {row[0] for row in cur.fetchall()}
            active_days = len(days)

            day_thresholds = [
                (3, "Regular", "Active for 3 days", "📅"),
                (7, "One Week Wonder", "Active for 7 days", "🗓️"),
                (14, "Two Week Streak", "Active for 14 days", "⚡"),
                (30, "Monthly Maven", "Active for 30 days", "🌟"),
            ]
            for threshold, title, desc, emoji in day_thresholds:
                milestones.append({
                    "title": title, "desc": desc, "emoji": emoji,
                    "target": threshold, "current": active_days,
                    "unlocked": active_days >= threshold,
                })

            # Most played single track
            cur.execute("""
                SELECT track_name, COUNT(*) AS cnt FROM play_history
                WHERE spotify_user_id = %s
                GROUP BY track_name ORDER BY cnt DESC LIMIT 1
            """, (spotify_user_id,))
            top_row = cur.fetchone()
            top_track_count = top_row[1] if top_row else 0
            top_track_name = top_row[0] if top_row else ""

            obsession_thresholds = [
                (5, "On Repeat", f"Played '{top_track_name}' 5+ times", "🔁"),
                (10, "Obsessed", f"Played '{top_track_name}' 10+ times", "😍"),
                (25, "Super Fan", f"Played '{top_track_name}' 25+ times", "⭐"),
            ]
            for threshold, title, desc, emoji in obsession_thresholds:
                milestones.append({
                    "title": title, "desc": desc, "emoji": emoji,
                    "target": threshold, "current": top_track_count,
                    "unlocked": top_track_count >= threshold,
                })

        return jsonify(milestones)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/weekly_summary")
def api_weekly_summary():
    """Weekly listening summary: this week vs last week stats."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    if not DATABASE_URL:
        return jsonify({"error": "no_database"}), 400

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    spotify_user_id = get_or_set_user_id(token)
    if not spotify_user_id:
        return jsonify({"error": "no_user"}), 400

    now = datetime.now(user_tz)
    # Start of this week (Monday 00:00)
    this_monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    last_monday = this_monday - timedelta(weeks=1)

    try:
        with get_db() as conn:
            if not conn:
                return jsonify({"error": "no_database"}), 400
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

            def week_stats(start, end):
                """Get stats for a given time range."""
                cur.execute("""
                    SELECT COUNT(*) AS total_plays,
                           COUNT(DISTINCT track_id) AS unique_tracks,
                           COUNT(DISTINCT artist_name) AS unique_artists
                    FROM play_history
                    WHERE spotify_user_id = %s
                      AND played_at >= %s AND played_at < %s
                """, (spotify_user_id, start, end))
                row = cur.fetchone()

                # Top track
                cur.execute("""
                    SELECT track_name, artist_name, COUNT(*) AS cnt
                    FROM play_history
                    WHERE spotify_user_id = %s
                      AND played_at >= %s AND played_at < %s
                    GROUP BY track_name, artist_name
                    ORDER BY cnt DESC LIMIT 5
                """, (spotify_user_id, start, end))
                top_tracks = [{"name": r["track_name"], "artist": r["artist_name"], "count": r["cnt"]} for r in cur.fetchall()]

                # Top artist
                cur.execute("""
                    SELECT artist_name, COUNT(*) AS cnt
                    FROM play_history
                    WHERE spotify_user_id = %s
                      AND played_at >= %s AND played_at < %s
                    GROUP BY artist_name
                    ORDER BY cnt DESC LIMIT 5
                """, (spotify_user_id, start, end))
                top_artists = [{"name": r["artist_name"], "count": r["cnt"]} for r in cur.fetchall()]

                # Hourly distribution
                cur.execute("""
                    SELECT EXTRACT(HOUR FROM played_at AT TIME ZONE %s)::INT AS hour,
                           COUNT(*) AS cnt
                    FROM play_history
                    WHERE spotify_user_id = %s
                      AND played_at >= %s AND played_at < %s
                    GROUP BY hour ORDER BY hour
                """, (tz_name, spotify_user_id, start, end))
                hourly = {r["hour"]: r["cnt"] for r in cur.fetchall()}

                # Daily distribution
                cur.execute("""
                    SELECT (played_at AT TIME ZONE %s)::DATE AS day,
                           COUNT(*) AS cnt
                    FROM play_history
                    WHERE spotify_user_id = %s
                      AND played_at >= %s AND played_at < %s
                    GROUP BY day ORDER BY day
                """, (tz_name, spotify_user_id, start, end))
                daily = [{"date": r["day"].isoformat(), "count": r["cnt"]} for r in cur.fetchall()]

                return {
                    "total_plays": row["total_plays"],
                    "unique_tracks": row["unique_tracks"],
                    "unique_artists": row["unique_artists"],
                    "top_tracks": top_tracks,
                    "top_artists": top_artists,
                    "hourly": [hourly.get(h, 0) for h in range(24)],
                    "daily": daily,
                }

            this_week = week_stats(this_monday, now)
            last_week = week_stats(last_monday, this_monday)

            # Compute changes
            def pct_change(current, previous):
                if previous == 0:
                    return 100 if current > 0 else 0
                return round((current - previous) / previous * 100)

            return jsonify({
                "this_week": this_week,
                "last_week": last_week,
                "changes": {
                    "plays": pct_change(this_week["total_plays"], last_week["total_plays"]),
                    "tracks": pct_change(this_week["unique_tracks"], last_week["unique_tracks"]),
                    "artists": pct_change(this_week["unique_artists"], last_week["unique_artists"]),
                },
                "period": {
                    "this_start": this_monday.isoformat(),
                    "last_start": last_monday.isoformat(),
                },
            })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profile_card")
def api_profile_card():
    """Aggregated profile data for a shareable card."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    tz_name = request.args.get("tz", "UTC")
    spotify_user_id = get_or_set_user_id(token)

    profile = spotify_get("/me", token)
    result = {
        "display_name": profile.get("display_name") or profile.get("id"),
        "image": profile["images"][0]["url"] if profile.get("images") else None,
        "top_tracks": [],
        "top_artists": [],
        "top_genre": None,
        "total_plays": 0,
        "active_days": 0,
        "streak": 0,
    }

    # Top tracks & artists
    try:
        tracks = spotify_get("/me/top/tracks", token, params={"limit": 5, "time_range": "short_term"})
        result["top_tracks"] = [{"name": t["name"], "artist": t["artists"][0]["name"]} for t in tracks.get("items", [])]
    except Exception:
        pass

    try:
        artists = spotify_get("/me/top/artists", token, params={"limit": 5, "time_range": "short_term"})
        result["top_artists"] = [a["name"] for a in artists.get("items", [])]
        # Top genre from top artist
        if artists.get("items") and artists["items"][0].get("genres"):
            result["top_genre"] = artists["items"][0]["genres"][0]
    except Exception:
        pass

    # DB stats
    if DATABASE_URL and spotify_user_id:
        try:
            with get_db() as conn:
                if conn:
                    cur = conn.cursor()
                    cur.execute("SELECT COUNT(*) FROM play_history WHERE spotify_user_id = %s", (spotify_user_id,))
                    result["total_plays"] = cur.fetchone()[0]

                    cur.execute("""
                        SELECT DISTINCT (played_at AT TIME ZONE %s)::DATE
                        FROM play_history WHERE spotify_user_id = %s
                    """, (tz_name, spotify_user_id))
                    days = {row[0] for row in cur.fetchall()}
                    result["active_days"] = len(days)

                    try:
                        user_tz = ZoneInfo(tz_name)
                    except Exception:
                        user_tz = ZoneInfo("UTC")
                    today = datetime.now(user_tz).date()
                    streak = 0
                    check = today
                    while check in days:
                        streak += 1
                        check -= timedelta(days=1)
                    result["streak"] = streak
        except Exception:
            pass

    return jsonify(result)


@app.route("/api/mood_scatter")
def api_mood_scatter():
    """Returns valence + energy per track for mood quadrant scatter plot."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    term = request.args.get("time_range", "short_term")
    top = spotify_get("/me/top/tracks", token, params={"limit": 50, "time_range": term})
    ids = [t["id"] for t in top.get("items", [])]
    if not ids:
        return jsonify([])
    try:
        feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
    except SpotifyForbiddenError:
        return jsonify({"error": "deprecated"}), 403
    feats = feat_data.get("audio_features") or []
    tracks = top.get("items", [])
    result = []
    for i, f in enumerate(feats):
        if not f or i >= len(tracks):
            continue
        t = tracks[i]
        result.append({
            "name": t["name"],
            "artist": t["artists"][0]["name"] if t["artists"] else "",
            "valence": round(f.get("valence", 0), 3),
            "energy": round(f.get("energy", 0), 3),
            "danceability": round(f.get("danceability", 0), 3),
        })
    return jsonify(result)


@app.route("/api/personality")
def api_personality():
    """Derives a music personality label from average audio features."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    top = spotify_get("/me/top/tracks", token, params={"limit": 20, "time_range": "short_term"})
    ids = [t["id"] for t in top.get("items", [])]
    if not ids:
        return jsonify({"type": "Unknown", "desc": "", "emoji": "🎵", "scores": {}})
    try:
        feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
    except SpotifyForbiddenError:
        return jsonify({"error": "deprecated"}), 403
    valid = [f for f in (feat_data.get("audio_features") or []) if f]
    if not valid:
        return jsonify({"type": "Unknown", "desc": "", "emoji": "🎵", "scores": {}})

    def avg(k): return sum(f.get(k, 0) for f in valid) / len(valid)

    energy = avg("energy")
    valence = avg("valence")
    dance = avg("danceability")
    acoustic = avg("acousticness")
    instru = avg("instrumentalness")
    speech = avg("speechiness")

    if speech > 0.35:
        p = {"type": "The Wordsmith",        "emoji": "🎤", "desc": "Lyrics and rhythm drive you — words are your music."}
    elif instru > 0.5:
        p = {"type": "The Instrumentalist",  "emoji": "🎼", "desc": "Pure sound moves you more than any lyric ever could."}
    elif acoustic > 0.65:
        p = {"type": "The Acoustic Soul",    "emoji": "🪵", "desc": "Raw, organic sound resonates with your spirit."}
    elif energy > 0.72 and valence > 0.65:
        p = {"type": "The Party Starter",    "emoji": "🎉", "desc": "High energy, great vibes — you light up every room."}
    elif energy > 0.72 and valence < 0.38:
        p = {"type": "The Intensity Seeker", "emoji": "⚡", "desc": "You channel raw emotion into powerful, driving music."}
    elif energy < 0.38 and valence > 0.62:
        p = {"type": "The Daydreamer",       "emoji": "☁️", "desc": "Calm, warm, and content — music is your happy place."}
    elif energy < 0.38 and valence < 0.38:
        p = {"type": "The Deep Thinker",     "emoji": "🌙", "desc": "You appreciate melancholy and emotional depth."}
    elif dance > 0.78:
        p = {"type": "The Dance Floor King", "emoji": "💃", "desc": "Your playlist keeps every crowd moving all night."}
    else:
        p = {"type": "The Eclectic Explorer", "emoji": "🌍", "desc": "Your taste is beautifully unpredictable and wide-ranging."}

    p["scores"] = {
        "Energy": round(energy * 100),
        "Valence": round(valence * 100),
        "Danceability": round(dance * 100),
        "Acousticness": round(acoustic * 100),
    }
    return jsonify(p)


@app.route("/api/recent_timeline")
def api_recent_timeline():
    """Recent plays formatted for a timeline view."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    items = []
    for item in data.get("items", []):
        t = item["track"]
        dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
        items.append({
            "name": t["name"],
            "artist": ", ".join(a["name"] for a in t["artists"]),
            "image": t["album"]["images"][0]["url"] if t["album"]["images"] else None,
            "played_at": item["played_at"],
            "date": dt.strftime("%b %d"),
            "time": dt.strftime("%H:%M"),
            "weekday": dt.strftime("%a"),
        })
    return jsonify(items)


@app.route("/api/decade_breakdown")
def api_decade_breakdown():
    """Distribution of tracks by release decade."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    term = request.args.get("time_range", "short_term")
    data = spotify_get("/me/top/tracks", token, params={"limit": 50, "time_range": term})
    decades = defaultdict(int)
    for t in data.get("items", []):
        rd = t["album"].get("release_date", "")
        if rd and len(rd) >= 4:
            year = int(rd[:4])
            decade = (year // 10) * 10
            decades[decade] += 1
    sorted_d = sorted(decades.items())
    return jsonify([{"decade": f"{d}s", "count": c} for d, c in sorted_d])


# ── Admin endpoints ────────────────────────────────────────────────────────────

@app.route("/api/admin/users")
def api_admin_users():
    """List all users with play counts. Admin only."""
    if not is_admin():
        return jsonify({"error": "forbidden"}), 403
    if not DATABASE_URL:
        return jsonify([])
    try:
        with get_db() as conn:
            if not conn:
                return jsonify([])
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT u.spotify_id, u.display_name, u.created_at,
                       COUNT(p.id) AS play_count
                FROM users u
                LEFT JOIN play_history p ON p.spotify_user_id = u.spotify_id
                GROUP BY u.spotify_id
                ORDER BY u.created_at DESC;
            """)
            users = cur.fetchall()
            for u in users:
                if u["created_at"]:
                    u["created_at"] = u["created_at"].isoformat()
            return jsonify(users)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/stats/<spotify_id>")
def api_admin_stats(spotify_id):
    """Full stats for any user: streak, top tracks, top artists, genres. Admin only."""
    if not is_admin():
        return jsonify({"error": "forbidden"}), 403
    if not DATABASE_URL:
        return jsonify({"error": "no_database"}), 400

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    result = {"spotify_id": spotify_id}

    # ── Streak & play stats from DB ──
    try:
        with get_db() as conn:
            if conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT DISTINCT (played_at AT TIME ZONE %s)::DATE AS play_date
                    FROM play_history WHERE spotify_user_id = %s
                    ORDER BY play_date DESC;
                """, (tz_name, spotify_id))
                days = {row[0] for row in cur.fetchall()}
                cur.execute("SELECT COUNT(*) FROM play_history WHERE spotify_user_id = %s", (spotify_id,))
                total_plays = cur.fetchone()[0]

                today = datetime.now(user_tz).date()
                streak = 0
                check = today
                while check in days:
                    streak += 1
                    check -= timedelta(days=1)

                result["streak"] = {"streak": streak, "active_days": len(days), "total_plays": total_plays}
    except Exception as e:
        result["streak"] = {"streak": 0, "active_days": 0, "total_plays": 0}

    # ── Get user's access token via stored refresh token ──
    user_token = None
    try:
        with get_db() as conn:
            if conn:
                cur = conn.cursor()
                cur.execute("SELECT refresh_token FROM users WHERE spotify_id = %s", (spotify_id,))
                row = cur.fetchone()
                if row:
                    user_token, _ = _refresh_token_for_user(row[0])
    except Exception:
        pass

    # ── Spotify API stats (need user's token) ──
    if user_token:
        try:
            top_tracks_data = spotify_get("/me/top/tracks", user_token, params={"limit": 10, "time_range": "short_term"})
            result["top_tracks"] = [{
                "name": t["name"],
                "artist": ", ".join(a["name"] for a in t["artists"]),
                "image": t["album"]["images"][0]["url"] if t["album"]["images"] else None,
            } for t in top_tracks_data.get("items", [])]
        except Exception:
            result["top_tracks"] = []

        try:
            top_artists_data = spotify_get("/me/top/artists", user_token, params={"limit": 10, "time_range": "short_term"})
            result["top_artists"] = [{
                "name": a["name"],
                "genres": a["genres"][:3],
                "image": a["images"][0]["url"] if a["images"] else None,
            } for a in top_artists_data.get("items", [])]
        except Exception:
            result["top_artists"] = []

        try:
            genre_data = spotify_get("/me/top/artists", user_token, params={"limit": 20, "time_range": "short_term"})
            genre_count = defaultdict(int)
            for artist in genre_data.get("items", []):
                for g in artist["genres"]:
                    genre_count[g] += 1
            sorted_genres = sorted(genre_count.items(), key=lambda x: x[1], reverse=True)
            result["genres"] = [{"genre": g, "count": c} for g, c in sorted_genres[:10]]
        except Exception:
            result["genres"] = []
    else:
        result["top_tracks"] = []
        result["top_artists"] = []
        result["genres"] = []

    return jsonify(result)


@app.route("/api/admin/heatmap/<spotify_id>")
def api_admin_heatmap(spotify_id):
    """View any user's heatmap. Admin only."""
    if not is_admin():
        return jsonify({"error": "forbidden"}), 403
    if not DATABASE_URL:
        return jsonify([])

    tz_name = request.args.get("tz", "UTC")
    try:
        user_tz = ZoneInfo(tz_name)
    except Exception:
        user_tz = ZoneInfo("UTC")

    grid = defaultdict(int)
    tracks_by_slot = defaultdict(list)
    try:
        with get_db() as conn:
            if not conn:
                return jsonify([])
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                SELECT track_name, played_at
                FROM play_history
                WHERE spotify_user_id = %s
                ORDER BY played_at DESC;
            """, (spotify_id,))
            for row in cur.fetchall():
                dt = row["played_at"]
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                dt = dt.astimezone(user_tz)
                day = dt.weekday()
                hour = dt.hour
                grid[(day, hour)] += 1
                tracks_by_slot[(day, hour)].append(row["track_name"])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    result = []
    for (day, hour), count in grid.items():
        result.append({
            "day": day,
            "hour": hour,
            "count": count,
            "tracks": tracks_by_slot[(day, hour)][:3],
        })
    return jsonify(result)


# ── Background sync (APScheduler) ─────────────────────────────────────────────

def _refresh_token_for_user(refresh_token):
    """Exchange a refresh_token for a fresh access_token (no Flask session needed)."""
    resp = requests.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    })
    data = resp.json()
    if "access_token" not in data:
        return None, None
    new_refresh = data.get("refresh_token")  # Spotify may rotate it
    return data["access_token"], new_refresh


def background_sync_all_users():
    """Runs periodically: loops through every user in the DB, refreshes their
    token, and syncs their last 50 plays. No Flask session required."""
    if not DATABASE_URL:
        return
    try:
        with get_db() as conn:
            if not conn:
                return
            cur = conn.cursor()
            cur.execute("SELECT spotify_id, refresh_token FROM users;")
            users = cur.fetchall()
    except Exception as e:
        print(f"[BG-SYNC] Failed to fetch users: {e}")
        return

    print(f"[BG-SYNC] Starting sync for {len(users)} user(s)…")
    for spotify_id, stored_refresh in users:
        try:
            access_token, new_refresh = _refresh_token_for_user(stored_refresh)
            if not access_token:
                print(f"[BG-SYNC] Token refresh failed for {spotify_id}, skipping")
                continue

            # Update refresh_token in DB if Spotify rotated it
            if new_refresh and new_refresh != stored_refresh:
                try:
                    with get_db() as conn:
                        if conn:
                            cur = conn.cursor()
                            cur.execute(
                                "UPDATE users SET refresh_token = %s, updated_at = NOW() WHERE spotify_id = %s",
                                (new_refresh, spotify_id)
                            )
                except Exception:
                    pass

            count = sync_recent_tracks(spotify_id, access_token)
            print(f"[BG-SYNC] {spotify_id}: +{count} new tracks")

        except Exception as e:
            print(f"[BG-SYNC] Error syncing {spotify_id}: {e}")

    print("[BG-SYNC] Done.")


# Start the scheduler (default: every 30 minutes)
SYNC_INTERVAL_MIN = int(os.getenv("SYNC_INTERVAL_MIN", "30"))

scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(
    background_sync_all_users,
    trigger="interval",
    minutes=SYNC_INTERVAL_MIN,
    id="bg_sync",
    replace_existing=True,
    max_instances=1,
)
scheduler.start()
atexit.register(lambda: scheduler.shutdown(wait=False))
print(f"[BG-SYNC] Scheduler started — syncing every {SYNC_INTERVAL_MIN} min")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
