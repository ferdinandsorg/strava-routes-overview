/**
 * Strava Routen-Map – Ein-Datei-App (Node + Leaflet)
 * ---------------------------------------------------
 * Minimalistische Full‑Stack-Webseite: Login via Strava, Zeitraum wählen,
 * Routen (summary_polyline) als Polylines auf der Karte anzeigen.
 *
 * Voraussetzungen
 *  - Node.js 18+ (wegen global fetch)
 *  - npm i express cookie-session
 *  - Strava-App registrieren: https://www.strava.com/settings/api
 *
 * Env Variablen
 *  - STRAVA_CLIENT_ID=12345
 *  - STRAVA_CLIENT_SECRET=your_secret
 *  - BASE_URL=http://localhost:3000
 */

// ===== Server-Setup =====
const express = require("express");
const crypto = require("crypto");
const session = require("cookie-session");

const app = express();
const PORT = process.env.PORT || 3000;

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.warn("⚠️  Bitte STRAVA_CLIENT_ID und STRAVA_CLIENT_SECRET als Umgebungsvariablen setzen.");
}

app.use(express.json());
app.use(
  session({
    name: "strava-demo",
    keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

// ===== Hilfsfunktionen =====
function isAuthed(req) {
  return Boolean(req.session && req.session.strava && req.session.strava.access_token);
}

async function tokenExchange(code) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

async function refreshIfNeeded(req) {
  const data = req.session && req.session.strava;
  if (!data) return;
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && data.expires_at - now <= 300) {
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: data.refresh_token,
      }),
    });
    if (res.ok) {
      const json = await res.json();
      req.session.strava = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: json.expires_at,
        athlete: json.athlete || data.athlete,
      };
    } else {
      console.error("Token refresh failed", await res.text());
    }
  }
}

async function stravaFetch(req, path, params = {}) {
  await refreshIfNeeded(req);
  const url = new URL(`${STRAVA_API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${req.session.strava.access_token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ===== OAuth Routen =====
app.get("/auth", (req, res) => {
  const state = crypto.randomBytes(8).toString("hex");
  req.session.oauth_state = state;
  const redirectUri = `${BASE_URL}/oauth/callback`;
  const scope = "activity:read,activity:read_all";
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set("client_id", STRAVA_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");
    if (state !== req.session.oauth_state) return res.status(400).send("Invalid state");
    const token = await tokenExchange(String(code));
    req.session.strava = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
      athlete: token.athlete,
    };
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth Fehler. Details in Server-Logs.");
  }
});

app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

// ===== API: Aktivitäten im Zeitraum holen =====
app.get("/api/activities", async (req, res) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "not_authenticated" });

    const after = req.query.after ? Number(req.query.after) : undefined; // epoch seconds
    const before = req.query.before ? Number(req.query.before) : undefined; // epoch seconds

    const per_page = 200;
    let page = 1;
    let all = [];

    while (true) {
      const batch = await stravaFetch(req, "/athlete/activities", {
        after,
        before,
        per_page,
        page,
      });
      all = all.concat(batch);
      if (!batch.length || batch.length < per_page) break;
      page += 1;
      if (page > 20) break; // Sicherung
    }

    const cleaned = all
      .filter((a) => a && a.map && a.map.summary_polyline)
      .map((a) => ({
        id: a.id,
        name: a.name,
        sport_type: a.sport_type || a.type,
        start_date: a.start_date,
        distance: a.distance,
        polyline: a.map.summary_polyline,
      }));

    res.json({ activities: cleaned });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error", message: String(e.message || e) });
  }
});

// ===== Frontend (HTML + Leaflet) =====
app.get("/", (req, res) => {
  const authed = isAuthed(req);
  const athleteName = req.session && req.session.strava && req.session.strava.athlete && req.session.strava.athlete.firstname
    ? `${req.session.strava.athlete.firstname} ${req.session.strava.athlete.lastname || ""}`.trim()
    : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Strava Routen</title>
  <link rel="preconnect" href="https://unpkg.com">
  <link rel="stylesheet" href="https://unpkg.com/modern-normalize/modern-normalize.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
  <style>
    :root { --bg: #0b0b10; --card: #161622; --ink: #eaeaf2; --muted: #9aa0b4; --accent: #ff6b00; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
    header { display:flex; gap:12px; align-items:center; justify-content:space-between; padding: 16px 20px; border-bottom:1px solid #24243a; position: sticky; top:0; background: linear-gradient(180deg, rgba(11,11,16,0.9), rgba(11,11,16,0.7)); backdrop-filter: blur(6px); }
    header h1 { margin:0; font-size: 18px; letter-spacing: 0.2px; font-weight:600; }
    header .right { display:flex; gap:8px; align-items:center; }
    main { padding: 16px; max-width: 1100px; margin: 0 auto; }
    .card {
      background: rgba(22, 22, 34, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px;
      position: fixed;
      top: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      width: max-content;               /* so breit wie der Inhalt */
      max-width: calc(100vw - 32px);    /* responsiv begrenzen */
    }
    .row { display:flex; gap:12px; flex-wrap: wrap; align-items: end;margin-top:12px;padding-top: 12px;border-top: 1px solid #2b2b43; }
    label { font-size: 12px; color: var(--muted); display:block; margin-bottom:6px; }
    input[type="date"] { background:#0f0f18; color:var(--ink); border:1px solid #2b2b43; border-radius:10px; padding:10px 12px; }
    select { background:#0f0f18; color:var(--ink); border:1px solid #2b2b43; border-radius:10px; padding:10px 12px; appearance:none; }
    .checkbox-chip { display:inline-flex; align-items:center; gap:8px; background:#0f0f18; color:var(--ink); border:1px solid #2b2b43; border-radius:10px; padding:10px 12px; }
    input[type="checkbox"] { accent-color: var(--accent); width:16px; height:16px; }

    /* Datepicker-Icon (WebKit) weiß färben */
    input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(1);
      opacity: 1;
    }

    /* Select: eigenes weißes Chevron (SVG) */
    select {
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='white'><path d='M7 10l5 5 5-5z'/></svg>");
      background-repeat: no-repeat;
      background-position: right 12px center;
      background-size: 12px 12px;
      padding-right: 36px; /* Platz fürs Chevron */
    }

    /* Heatmap-Toggle optisch wie ein Input; bündig mit Unterkante */
    .checkbox-chip {
      height: 40px;             /* gleiche visuelle Höhe wie Date/Select */
      display: inline-flex;
      align-items: center;
      padding: 10px 12px;       /* identisch zu Inputs */
      line-height: 1.2;
    }
    button, .btn { background: var(--accent); color:#111; border:0; border-radius:12px; padding:10px 14px; font-weight:600; cursor:pointer; text-decoration:none; }
    button.secondary { background:#2b2b43; color:#eaeaf2; }
    .muted { color: var(--muted); font-size: 13px; }
    #map { position: fixed; inset: 0; height: 100vh; width: 100vw; border: none; border-radius: 0; margin: 0; z-index: 0; }
    .hidden { display:none; }
    .tag { font-size: 11px; padding:2px 8px; border-radius: 999px; background:#23233a; color:#cdd3ea; border:1px solid #2d2d47; }
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 1000; background: var(--accent); color:#111; border:0; border-radius: 999px; padding:12px 16px; font-weight:600; cursor:pointer; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
    a { color: #d2ddff; }
    .leaflet-popup-content-wrapper {
      background: rgba(22, 22, 34, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px;
    }
    .leaflet-popup-content {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }
    .leaflet-popup-content a {
      color: var(--accent);
    }
    .leaflet-popup-content-wrapper, .leaflet-popup-tip {
      background: rgba(22, 22, 34, 0.85);
    }
  </style>
</head>
<body>
  <main>
    <div class="card">
    <div class="login-panel" style="display:flex; gap:10px; align-items:center;justify-content: space-between;">
        ${
          authed
            ? '<span class="muted">Eingeloggt als <strong>' + (athleteName || 'Athlete') + '</strong></span>' +
              '<form method="post" action="/logout" style="margin:0"><button class="secondary" type="submit">Logout</button></form>'
            : '<span class="muted">Bitte zuerst einloggen.</span>' +
              '<a class="btn" href="/auth">Mit Strava einloggen</a>'
        }
      </div>
      <div class="row ${authed ? '' : 'hidden'}">
        <div>
          <label>Von</label>
          <input id="from" type="date" />
        </div>
        <div>
          <label>Bis</label>
          <input id="to" type="date" />
        </div>
        <div>
          <label>Sportart</label>
          <select id="sport">
            <option value="all">Alle</option>
          </select>
        </div>
        <div>
          <label>Kartenstil</label>
          <select id="style">
            <option value="dark" selected>Dark Map</option>
            <option value="positron">Light Map</option>
            <option value="osm">OSM Standard</option>
            <option value="satellite">Satellit</option>
          </select>
        </div>
        <div>
          <label>Darstellung</label>
          <label style="display:flex; gap:6px; align-items:center; font-size:13px; user-select:none;margin:0;">
            <span class="checkbox-chip"><input id="heat" type="checkbox" /> Heatmap</span>
          </label>
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="load" ${authed ? '' : 'disabled'}>Routen laden</button>
        </div>
        <div style="width:100%">
          <span class="tag">Zeitzone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </div>
      </div>
    </div>
    <div id="map" class="${authed ? '' : 'hidden'}"></div>
    <button id="saveFab" class="fab ${authed ? '' : 'hidden'}">Als Bild speichern</button>
  </main>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script src="https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <script src="https://unpkg.com/leaflet.heat/dist/leaflet-heat.js"></script>
  <script>
  // --- Polyline Decoder ---
  function decodePolyline(str, precision) {
    var index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change;
    var factor = Math.pow(10, precision || 5);
    while (index < str.length) {
      byte = null; shift = 0; result = 0;
      do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
      shift = 0; result = 0;
      do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lat += latitude_change; lng += longitude_change;
      coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
  }

  // --- UI / Map Logic ---
  var mapEl = document.getElementById('map');
  var map = L.map(mapEl, { zoomControl: true });

  var baseLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      crossOrigin: 'anonymous'
    }),
    positron: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
      crossOrigin: 'anonymous'
    }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
      crossOrigin: 'anonymous'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, and the GIS User Community',
      crossOrigin: 'anonymous'
    })
  };

  var currentBase = baseLayers.dark.addTo(map);
  map.setView([51.163, 10.447], 5);

  var from = document.getElementById('from');
  var to = document.getElementById('to');
  var loadBtn = document.getElementById('load');
  var sport = document.getElementById('sport');
  var heatToggle = document.getElementById('heat');
  var styleSel = document.getElementById('style');
  var saveBtn = document.getElementById('saveFab');
  async function saveMapAsImage() {
    try {
      if (!window.html2canvas) {
        alert('html2canvas nicht geladen.');
        return;
      }
      // Ensure map has the latest size/tiles laid out and window scrolled to top
      window.scrollTo(0,0);

      var controls = mapEl.querySelector('.leaflet-control-container');
      var headerEl = document.querySelector('header');
      var cardEl = document.querySelector('.card');
      var fabEl = document.getElementById('saveFab');

      // Temporarily hide UI overlays
      var prev = {
        controlsVis: controls ? controls.style.visibility : null,
        headerVis: headerEl ? headerEl.style.visibility : null,
        cardVis: cardEl ? cardEl.style.visibility : null,
        fabVis: fabEl ? fabEl.style.visibility : null,
        mapBorder: mapEl.style.border,
        mapRadius: mapEl.style.borderRadius
      };
      if (controls) controls.style.visibility = 'hidden';
      if (headerEl) headerEl.style.visibility = 'hidden';
      if (cardEl) cardEl.style.visibility = 'hidden';
      if (fabEl) fabEl.style.visibility = 'hidden';
      mapEl.style.border = 'none';
      mapEl.style.borderRadius = '0';

      map.invalidateSize();

      var rect = mapEl.getBoundingClientRect();
      var canvas = await html2canvas(mapEl, {
        useCORS: true,
        backgroundColor: null,
        scale: 2,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        windowWidth: document.documentElement.clientWidth,
        windowHeight: document.documentElement.clientHeight,
      });

      // Restore UI overlays and map styles
      if (controls) controls.style.visibility = prev.controlsVis;
      if (headerEl) headerEl.style.visibility = prev.headerVis;
      if (cardEl) cardEl.style.visibility = prev.cardVis;
      if (fabEl) fabEl.style.visibility = prev.fabVis;
      mapEl.style.border = prev.mapBorder;
      mapEl.style.borderRadius = prev.mapRadius;

      var ts = new Date();
      function pad(n){ return String(n).padStart(2, '0'); }
      var fname = 'strava-map-' + ts.getFullYear() + pad(ts.getMonth()+1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds()) + '.png';

      var link = document.createElement('a');
      link.download = fname;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.error('Fehler beim Export:', e);
      alert('Konnte die Karte nicht als Bild speichern. Details in der Konsole.');
    }
  }

  var today = new Date();
  var oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(today.getMonth() - 1);
  function toInputDate(d){ return d.toISOString().slice(0,10); }
  from.value = toInputDate(oneMonthAgo);
  to.value = toInputDate(today);

  function toEpochSecondsLocalStart(dStr){
    var d = new Date(dStr + 'T00:00:00');
    return Math.floor(d.getTime()/1000);
  }
  function toEpochSecondsLocalEnd(dStr){
    var d = new Date(dStr + 'T23:59:59');
    return Math.floor(d.getTime()/1000);
  }

  var routesLayer = L.layerGroup().addTo(map);
  var heatLayer = null;

  var allActivities = [];

  function renderRoutes() {
    // clear existing layers
    routesLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    var bounds = [];
    var selected = sport ? sport.value : 'all';

    var filtered = allActivities.filter(function(a){
      if (!a.polyline) return false;
      if (!selected || selected === 'all') return true;
      var st = (a.sport_type || '').toLowerCase();
      return st === selected.toLowerCase();
    });

    // If heatmap toggle is ON → render heatmap instead of polylines
    if (heatToggle && heatToggle.checked) {
      var freq = new Map();
      function pushPoint(lat, lng) {
        var rlat = Math.round(lat * 10000) / 10000; // ~11m grid
        var rlng = Math.round(lng * 10000) / 10000;
        var key = rlat + ',' + rlng;
        var v = freq.get(key);
        if (!v) v = { lat: rlat, lng: rlng, w: 0 };
        v.w += 1;
        freq.set(key, v);
        bounds.push([lat, lng]);
      }

      filtered.forEach(function(a){
        var coords = decodePolyline(a.polyline);
        for (var i = 0; i < coords.length; i++) {
          var c = coords[i];
          pushPoint(c[0], c[1]);
          if (i < coords.length - 1) {
            var n = coords[i + 1];
            var dLat = n[0] - c[0];
            var dLng = n[1] - c[1];
            var dist = Math.sqrt(dLat * dLat + dLng * dLng);
            var steps = Math.max(0, Math.floor(dist / 0.0005)); // add points roughly every ~55m
            for (var s = 1; s <= steps; s++) {
              var lat = c[0] + (dLat * s / (steps + 1));
              var lng = c[1] + (dLng * s / (steps + 1));
              pushPoint(lat, lng);
            }
          }
        }
      });

      var heatData = Array.from(freq.values()).map(function(p){ return [p.lat, p.lng, p.w]; });
      if (heatData.length) {
        heatLayer = L.heatLayer(heatData, { radius: 6, blur: 8, minOpacity: 0.3, maxZoom: 18 }).addTo(map);
      }
    } else {
      // Default: draw polylines
      filtered.forEach(function(a){
        var coords = decodePolyline(a.polyline);
        if (!coords.length) return;
        var line = L.polyline(coords, { weight: 3, opacity: 0.9, color: '#FC5201' });
        line.bindPopup('<span style="color:#fff;margin-bottom:4px">' + a.name + '</span><span class="muted" style="margin-bottom:12px">' + new Date(a.start_date).toLocaleString() + '</span><span class="tag" style="margin-bottom:6px">' + (a.sport_type || '') + '</span>' + '<a href="https://www.strava.com/activities/' + a.id + '" target="_blank" rel="noopener noreferrer">Auf Strava öffnen</a>');
        routesLayer.addLayer(line);
        coords.forEach(function(c){ bounds.push(c); });
      });
    }

    if (bounds.length){
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  async function loadRoutes(){
    if (!from.value || !to.value){
      alert('Bitte wähle einen gültigen Zeitraum.');
      return;
    }
    loadBtn.disabled = true; loadBtn.textContent = 'Lade…';
    routesLayer.clearLayers();

    var params = new URLSearchParams({
      after: String(toEpochSecondsLocalStart(from.value)),
      before: String(toEpochSecondsLocalEnd(to.value)),
    });

    try {
      var res = await fetch('/api/activities?' + params.toString());
      if (res.status === 401){
        alert('Nicht eingeloggt. Bitte mit Strava einloggen.');
        return;
      }
      var data = await res.json();
      allActivities = data.activities || [];

      // Sportarten-Dropdown dynamisch füllen
      if (sport) {
        var current = sport.value;
        var values = Array.from(new Set(allActivities.map(function(a){ return (a.sport_type || '').trim(); }).filter(Boolean)) ).sort();
        // Reset options (preserve "Alle")
        sport.innerHTML = '<option value="all">Alle</option>' + values.map(function(v){
          return '<option value="' + v + '">' + v + '</option>';
        }).join('');
        // If previous selection still exists, keep it
        if (values.indexOf(current) !== -1) sport.value = current; else sport.value = 'all';
      }

      renderRoutes();
    } catch (e){
      console.error(e);
      alert('Fehler beim Laden der Routen. Details in der Konsole.');
    } finally {
      loadBtn.disabled = false; loadBtn.textContent = 'Routen laden';
    }
  }

  if (sport) sport.addEventListener('change', renderRoutes);
  if (heatToggle) heatToggle.addEventListener('change', renderRoutes);

  if (styleSel) styleSel.addEventListener('change', function(){
    if (currentBase) { map.removeLayer(currentBase); }
    var key = styleSel.value || 'osm';
    currentBase = baseLayers[key] || baseLayers.osm;
    currentBase.addTo(map);
  });

  if (saveBtn) saveBtn.addEventListener('click', saveMapAsImage);
  if (loadBtn) loadBtn.addEventListener('click', loadRoutes);
  ${authed ? "loadRoutes();" : ""}
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚴 Strava Routen-Map läuft auf ${BASE_URL}`);
});