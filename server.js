import express from "express";
import fs from "fs";
import path from "path";

/* ========== Konfig ========== */
const PORT = process.env.PORT || 3000;

// Din AIS-proxy (den vi redan kör)
const AIS_PROXY_URL = "https://tarbitaisproxy.onrender.com/positions";

// Molnsync-nyckel (kan bytas i Render env var SYNC_KEY)
const SYNC_KEY = process.env.SYNC_KEY || "tarbit2025";

// (Valfritt) persistent lagring – lägg till en Disk i Render och montera t.ex. /data
const STATE_PATH = process.env.STATE_PATH || "/data/fleetops_state.json";

/* ========== AIS-cache ========== */
let latestData = {};       // { mmsi: {...}, ... }
let lastUpdated = null;    // ISO-tid för senaste lyckade hämtning

async function updateAISData() {
  try {
    const res = await fetch(AIS_PROXY_URL, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`AIS proxy ${res.status}`);
    const json = await res.json();

    // proxy returns { lastUpdated, positions: {...} } – hantera båda varianter
    const positions = json.positions || json || {};
    if (positions && typeof positions === "object" && Object.keys(positions).length > 0) {
      latestData = positions;
      lastUpdated = new Date().toISOString();
      console.log("[AIS] updated", lastUpdated);
    } else {
      console.log("[AIS] no data, keeping cache");
    }
  } catch (e) {
    console.warn("[AIS] fetch error:", e.message || e);
  }
}

// starta pollning var 2:e minut
setInterval(updateAISData, 120000);
updateAISData();

/* ========== Molnsync (dashboard-state) ========== */
let stateCache = null;     // senaste state-objektet
let stateUpdatedAt = null; // ISO

// läs från disk om möjligt
try {
  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // stöd för format {updatedAt, data}
    if (parsed && typeof parsed === "object") {
      stateCache = parsed.data ?? parsed;
      stateUpdatedAt = parsed.updatedAt ?? new Date().toISOString();
      console.log("[STATE] loaded from disk:", STATE_PATH);
    }
  }
} catch (e) {
  console.warn("[STATE] could not read disk:", e.message);
}

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}
function saveToDiskSafe(obj) {
  try {
    ensureDir(STATE_PATH);
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.warn("[STATE] disk write skipped:", e.message);
    return false;
  }
}
function unauthorized(res) {
  return res.status(401).json({ error: "unauthorized" });
}

/* ========== HTTP-server ========== */
const app = express();

// CORS för Netlify m.fl.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Liten health
app.get("/", (req, res) => {
  res.json({ ok: true, lastUpdated, cacheSize: Object.keys(latestData||{}).length });
});

// AIS-data för din frontend
app.get("/positions", (req, res) => {
  res.json({ lastUpdated, positions: latestData });
});

// Hämta sparat dashboard-state
app.get("/state", (req, res) => {
  if ((req.query.key || "") !== SYNC_KEY) return unauthorized(res);
  const persisted = fs.existsSync(STATE_PATH);
  res.json({ updatedAt: stateUpdatedAt, data: stateCache ?? null, persisted });
});

// Spara dashboard-state (ersätter hela objektet)
app.put("/state", express.json({ limit: "2mb" }), (req, res) => {
  if ((req.query.key || "") !== SYNC_KEY) return unauthorized(res);
  if (typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "body must be a JSON object" });
  }
  stateCache = req.body;
  stateUpdatedAt = new Date().toISOString();
  const ok = saveToDiskSafe({ updatedAt: stateUpdatedAt, data: stateCache });
  res.json({ ok: true, updatedAt: stateUpdatedAt, persisted: ok });
});

app.listen(PORT, () => {
  console.log("HTTP listening on", PORT);
});
