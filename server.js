import express from "express";
import { WebSocket } from "ws";

/* ========= Config ========= */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

/* Nordvästra Europa – grova rutor som täcker SE/NO/Nordsjön/UK/FR/NL */
const NW_EU_BOXES = [
  [[54, 10], [66, 24]],   // Sverige / västra Östersjön
  [[58, 5],  [72, 31]],   // Norge / norska havet (sydliga)
  [[51, -5], [61, 9]],    // Nordsjön
  [[48, -6], [52, 2]],    // Engelska kanalen
  [[51, 2],  [54, 6]],    // NL/BE-kusten
  [[44, -10],[49, -1]]    // Bay of Biscay (norra)
];

/* Dina fartyg (MMSI som STRÄNGAR) */
const DEFAULT_MMSI = ["244944000", "244813000"]; // Bit Power, Bit Force

/* ========= State ========= */
let ws;
let pingTimer;
let reconnectTimer;
let currentSub = null;

let msgCount = 0;
let lastMsgAt = null;
let lastRaw = "";

/* Senaste kända position per MMSI */
const latest = new Map(); // mmsi -> { mmsi, lat, lon, sogKnots, navStatus, ts }

/* Loggring för /logs */
const MAX_LOG = 120;
const ring = [];
const logLine = (level, text) => {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  (level === "ERR" ? console.error : console.log)(line);
  ring.push(line);
  if (ring.length > MAX_LOG) ring.shift();
};

/* ========= Helpers ========= */
function buildSubscribePayload({ mmsi = [], boxes = [], all = false } = {}) {
  const payload = {
    APIKey: API_KEY,
    FilterMessageTypes: ["PositionReport"]
  };
  if (!all) payload.BoundingBoxes = boxes.length ? boxes : NW_EU_BOXES;
  if (mmsi.length) payload.FiltersShipMMSI = mmsi.map(String); // AISstream vill ha STRÄNGAR
  return payload;
}

function applyMessage(obj) {
  const mm = obj?.MetaData?.MMSI ? String(obj.MetaData.MMSI) : null;
  if (!mm) return;

  const m = obj?.Message?.PositionReport || obj?.Message || {};
  const lat = m.Latitude ?? m.Lat ?? obj?.MetaData?.latitude ?? null;
  const lon = m.Longitude ?? m.Lon ?? obj?.MetaData?.longitude ?? null;
  const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
  const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;
  const ts  = obj?.MetaData?.time_utc || lastMsgAt || new Date().toISOString();

  if (lat != null || lon != null || sog != null) {
    latest.set(mm, { mmsi: mm, lat, lon, sogKnots: sog, navStatus: nav, ts });
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

    if (msgCount % 50 === 1) {
      logLine("LOG", `RX sample: ${txt.slice(0, 300)}${txt.length > 300 ? " …" : ""}`);
    }

    try {
      const obj = JSON.parse(txt);
      if (obj?.error) {
        logLine("ERR", `AISstream error: ${obj.error}`);
        return;
      }
      applyMessage(obj);
    } catch { /* ignore non-JSON */ }
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

/* ========= Start: NW Europe + dina två MMSI ========= */
openSocket({ mmsi: DEFAULT_MMSI, boxes: NW_EU_BOXES });

/* ========= HTTP API ========= */
const app = express();

app.get("/", (req, res) => res.json({ ok: true }));

// Senaste positioner – valfritt filter via ?mmsi=244944000,244813000
app.get("/positions", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const filter = (req.query.mmsi || "").toString().trim();
  const only = filter ? filter.split(",").map(s => s.trim()) : null;
  const out = {};
  for (const [mm, val] of latest.entries()) {
    if (!only || only.includes(mm)) out[mm] = val;
  }
  res.json(out);
});

// Kort endpoint för dina (eller angivna) – perfekt för frontenden att polla
app.get("/last", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const filter = (req.query.mmsi || "").toString().trim();
  const mmsiList = filter ? filter.split(",").map(s => s.trim()) : DEFAULT_MMSI;
  const out = {};
  mmsiList.forEach(mm => { out[mm] = latest.get(mm) || null; });
  res.json(out);
});

app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    apiKeyLoaded: !!API_KEY,
    msgCount,
    lastMsgAt,
    have: Array.from(latest.keys()).slice(-30),
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

/* ====== Byt filter i runtime (utan redeploy) ======
   - /resub?nwe=1
   - /resub?mmsi=244944000,244813000&nwe=1
   - /resub?bbox=minLat,minLon,maxLat,maxLon
   - /resub?all=1   (hela världen – varning: mycket data)
*/
app.get("/resub", (req, res) => {
  const q = req.query;
  const mmsi = (q.mmsi || "").toString().trim()
    ? q.mmsi.toString().split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const all = q.all === "1";
  const nwe = q.nwe === "1";

  let boxes = [];
  if (!all) {
    if (q.bbox) {
      const [minLat, minLon, maxLat, maxLon] = q.bbox.split(",").map(Number);
      if ([minLat, minLon, maxLat, maxLon].every(n => Number.isFinite(n))) {
        boxes.push([[minLat, minLon], [maxLat, maxLon]]);
      }
    }
    if (nwe || (!q.bbox && mmsi.length && !all)) {
      boxes = NW_EU_BOXES;
    }
  }

  msgCount = 0; lastMsgAt = null; lastRaw = "";
  logLine("LOG", `Resubscribe: all=${all}, nwe=${nwe}, mmsi=${mmsi.join(",")}, boxes=${boxes.length}`);
  openSocket({ mmsi, boxes, all });
  res.json({ ok: true, all, nwe, mmsi, boxes: boxes.length });
});

app.get("/status", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ currentSub, msgCount, lastMsgAt, cacheSize: latest.size });
});

app.listen(PORT, () => logLine("LOG", `HTTP listening on ${PORT}`));
