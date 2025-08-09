import express from "express";
import { WebSocket } from "ws";

/* ========= Config ========= */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

/* ========= State ========= */
let ws;
let pingTimer;
let reconnectTimer;
let currentSub = null;

let msgCount = 0;
let lastMsgAt = null;
let lastRaw = "";

const latest = new Map(); // mmsi -> {lat,lon,sogKnots,navStatus,ts}

const MAX_LOG = 120;
const ring = [];
const logLine = (level, text) => {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  (level === "ERR" ? console.error : console.log)(line);
  ring.push(line);
  if (ring.length > MAX_LOG) ring.shift();
};

/* ========= Subscribe helpers ========= */
function buildSubscribePayload(opts) {
  // opts: { all?: boolean, mmsi?: string[] }
  const payload = {
    APIKey: API_KEY,
    // Global bbox rekommenderas: annars får man "Malformed" ibland
    BoundingBoxes: [[[-90, -180], [90, 180]]],
    // Be bara om positionsrapporter så det inte blir *för* mycket data
    FilterMessageTypes: ["PositionReport"]
  };
  if (opts?.mmsi && opts.mmsi.length) {
    // AISstream vill ha MMSI som STRÄNGAR
    payload.FiltersShipMMSI = opts.mmsi.map(String);
  }
  return payload;
}

function applyMessage(obj) {
  // MMSI
  const mm = obj?.MetaData?.MMSI ? String(obj.MetaData.MMSI) : null;
  if (!mm) return;

  // Position/fart/status
  const m = obj?.Message?.PositionReport || obj?.Message || {};
  const lat = m.Latitude ?? m.Lat ?? obj?.MetaData?.latitude ?? null;
  const lon = m.Longitude ?? m.Lon ?? obj?.MetaData?.longitude ?? null;
  const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
  const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

  if (lat != null || lon != null || sog != null) {
    latest.set(mm, {
      mmsi: mm,
      lat, lon,
      sogKnots: sog,
      navStatus: nav,
      ts: obj?.MetaData?.time_utc || lastMsgAt || new Date().toISOString()
    });
  }
}

function openSocket(subOpts) {
  logLine("LOG", "Connecting to AISstream…");
  try { ws?.close(); } catch {}
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);

  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    currentSub = buildSubscribePayload(subOpts);
    const payload = JSON.stringify(currentSub);
    logLine("LOG", `WS open. Sending subscribe: ${payload}`);
    ws.send(payload);

    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    const txt = raw.toString();
    lastRaw = txt;
    msgCount++;
    lastMsgAt = new Date().toISOString();

    // Logga första 500 tecken av varje RX
    logLine("LOG", `RX: ${txt.slice(0, 500)}${txt.length > 500 ? " …" : ""}`);

    try {
      const obj = JSON.parse(txt);
      if (obj?.error) {
        logLine("ERR", `AISstream error: ${obj.error}`);
        return;
      }
      applyMessage(obj);
    } catch {
      // om inte JSON – ignorera, men RX är redan loggad
    }
  });

  ws.on("close", () => {
    logLine("ERR", "WS closed. Reconnecting in 5s…");
    clearInterval(pingTimer);
    reconnectTimer = setTimeout(() => openSocket(subOpts), 5000);
  });

  ws.on("error", (e) => {
    logLine("ERR", `WS error: ${e?.message || e}`);
    try { ws.close(); } catch {}
  });
}

/* ========= Start: GLOBAL lyssning ========= */
openSocket({ all: true }); // globalt (ingen MMSI-filtrering)

/* ========= HTTP API ========= */
const app = express();

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/positions", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const out = {};
  for (const [mm, val] of latest.entries()) out[mm] = val;
  res.json(out);
});

app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    apiKeyLoaded: !!API_KEY,
    msgCount,
    lastMsgAt,
    have: Array.from(latest.keys()).slice(-20), // visa några MMSI vi sett
    currentSub
  });
});

app.get("/peek", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("application/json").send(lastRaw || '{"info":"No data yet"}');
});

app.get("/logs", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("text/plain").send(ring.join("\n"));
});

/* ===== Byt filter i runtime (utan redeploy) =====
   - /resub?all=1
   - /resub?mmsi=244944000,244813000
*/
app.get("/resub", (req, res) => {
  const mmsiParam = (req.query.mmsi || "").toString().trim();
  const all = req.query.all === "1";
  const mmsi = mmsiParam
    ? mmsiParam.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  // Nollställ enkel statistik/peeks för tydlighet
  msgCount = 0; lastMsgAt = null; lastRaw = "";

  // Om du vill rensa tidigare cache av positioner vid resub, avkommentera:
  // latest.clear();

  if (all || mmsi.length === 0) {
    logLine("LOG", "Resubscribe: GLOBAL (no MMSI filter)");
    openSocket({ all: true });
    return res.json({ ok: true, mode: "all" });
  } else {
    logLine("LOG", `Resubscribe: MMSI = ${mmsi.join(",")}`);
    openSocket({ mmsi });
    return res.json({ ok: true, mode: "mmsi", mmsi });
  }
});

app.get("/status", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ currentSub, msgCount, lastMsgAt, cacheSize: latest.size });
});

app.listen(PORT, () => logLine("LOG", `HTTP listening on ${PORT}`));

