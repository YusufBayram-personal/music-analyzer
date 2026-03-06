import os
import json
import time
from datetime import datetime, timedelta
from collections import defaultdict
from urllib.parse import urlencode

import requests
from flask import Flask, redirect, request, session, jsonify, render_template
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-in-production")

CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", "http://localhost:5000/callback")

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"

SCOPES = "user-read-recently-played user-top-read user-read-playback-state user-library-read"


def spotify_get(endpoint, token, params=None):
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(f"{API_BASE}{endpoint}", headers=headers, params=params)
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
        return data["access_token"]
    return None


def get_valid_token():
    if time.time() > session.get("token_expiry", 0) - 60:
        return refresh_access_token()
    return session.get("access_token")


# ── Routes ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    if "access_token" not in session:
        return render_template("index.html", logged_in=False)
    return render_template("index.html", logged_in=True)


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
    session["access_token"] = data["access_token"]
    session["refresh_token"] = data.get("refresh_token", "")
    session["token_expiry"] = time.time() + data.get("expires_in", 3600)
    return redirect("/")


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")


# ── API endpoints ────────────────────────────────────────────────────────────

@app.route("/api/profile")
def api_profile():
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify(spotify_get("/me", token))


@app.route("/api/recent")
def api_recent():
    """Returns last 50 recently played tracks with timestamps."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    return jsonify(data)


@app.route("/api/weekly_heatmap")
def api_weekly_heatmap():
    """
    Returns a 7×24 grid (day × hour) of play counts from the last 50 plays.
    day: 0=Monday … 6=Sunday, hour: 0-23
    """
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    grid = defaultdict(int)   # {(day, hour): count}
    tracks_by_slot = defaultdict(list)

    for item in data.get("items", []):
        played_at = item["played_at"]       # "2024-01-15T14:32:10.000Z"
        dt = datetime.strptime(played_at, "%Y-%m-%dT%H:%M:%S.%fZ")
        day = dt.weekday()   # 0=Mon … 6=Sun
        hour = dt.hour
        grid[(day, hour)] += 1
        tracks_by_slot[(day, hour)].append(item["track"]["name"])

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
    term = request.args.get("time_range", "short_term")  # short/medium/long
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

    feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
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
    """Count distinct days listened in the recent plays."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401

    data = spotify_get("/me/player/recently-played", token, params={"limit": 50})
    days = set()
    for item in data.get("items", []):
        dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
        days.add(dt.date())

    today = datetime.utcnow().date()
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


@app.route("/api/mood_scatter")
def api_mood_scatter():
    """Returns valence + energy per track for mood quadrant scatter plot."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    term = request.args.get("time_range", "short_term")
    top  = spotify_get("/me/top/tracks", token, params={"limit": 50, "time_range": term})
    ids  = [t["id"] for t in top.get("items", [])]
    if not ids:
        return jsonify([])
    feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
    feats = feat_data.get("audio_features") or []
    tracks = top.get("items", [])
    result = []
    for i, f in enumerate(feats):
        if not f or i >= len(tracks):
            continue
        t = tracks[i]
        result.append({
            "name":     t["name"],
            "artist":   t["artists"][0]["name"] if t["artists"] else "",
            "valence":  round(f.get("valence", 0), 3),
            "energy":   round(f.get("energy", 0), 3),
            "danceability": round(f.get("danceability", 0), 3),
        })
    return jsonify(result)


@app.route("/api/personality")
def api_personality():
    """Derives a music personality label from average audio features."""
    token = get_valid_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    top  = spotify_get("/me/top/tracks", token, params={"limit": 20, "time_range": "short_term"})
    ids  = [t["id"] for t in top.get("items", [])]
    if not ids:
        return jsonify({"type": "Unknown", "desc": "", "emoji": "🎵", "scores": {}})
    feat_data = spotify_get("/audio-features", token, params={"ids": ",".join(ids)})
    valid = [f for f in (feat_data.get("audio_features") or []) if f]
    if not valid:
        return jsonify({"type": "Unknown", "desc": "", "emoji": "🎵", "scores": {}})

    def avg(k): return sum(f.get(k, 0) for f in valid) / len(valid)

    energy   = avg("energy")
    valence  = avg("valence")
    dance    = avg("danceability")
    acoustic = avg("acousticness")
    instru   = avg("instrumentalness")
    speech   = avg("speechiness")

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
        p = {"type": "The Eclectic Explorer","emoji": "🌍", "desc": "Your taste is beautifully unpredictable and wide-ranging."}

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
        t  = item["track"]
        dt = datetime.strptime(item["played_at"], "%Y-%m-%dT%H:%M:%S.%fZ")
        items.append({
            "name":      t["name"],
            "artist":    ", ".join(a["name"] for a in t["artists"]),
            "image":     t["album"]["images"][0]["url"] if t["album"]["images"] else None,
            "played_at": item["played_at"],
            "date":      dt.strftime("%b %d"),
            "time":      dt.strftime("%H:%M"),
            "weekday":   dt.strftime("%a"),
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
            year   = int(rd[:4])
            decade = (year // 10) * 10
            decades[decade] += 1
    sorted_d = sorted(decades.items())
    return jsonify([{"decade": f"{d}s", "count": c} for d, c in sorted_d])


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
