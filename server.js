import express from "express";
import { WebSocket } from "ws";

/* ========= Config ========= */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

/* AISstream kräver:
   - BoundingBoxes (obligatoriskt)
   - FiltersShipMMSI som STRÄNGAR
   - FilterMessageTypes (valfritt, här "PositionReport")
   Ref: https://aisstream.io/documentation */
const MMSI_STR = ["244944000", "244813000"]; // Bit Power, Bit Force

/* ========= State ========= */
const latest = new Map(); // mmsi -> {lat, lon, sogKnots, navStatus, ts}
let ws;
let pingTimer;
let reconnectTimer;
let msgCount = 0;
let lastMsgAt = null;
let lastRaw = "";

const MAX_LOG = 80;
const ring = [];
const logLine = (level, text) => {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  (level === "ERR" ? console.error : console.log)(line);
  ring.push(line);
  if (ring.length > MAX_LOG) ring.shift();
};

/* ========= Connect ========= */
function connect() {
  logLine("LOG", "Connecting to AISstream…");
  try { ws?.close(); } catch {}
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);

  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    logLine("LOG", "WS open. Sending subscribe with BoundingBoxes + FiltersShipMMSI…");

    const sub = {
      APIKey: API_KEY,
      // Global bbox (krävs av AISstream)
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      // MMSI som STRÄNGAR (krävs av AISstream)
      FiltersShipMMSI: MMSI_STR,
      // Valfritt filter – funkar enligt docs
      FilterMessageTypes: ["PositionReport"]
    };

    const payload = JSON.stringify(sub);
    logLine("LOG", `Subscribe payload: ${payload}`);
    ws.send(payload);

    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    const txt = raw.toString();
    lastRaw = txt;
    msgCount++;
    lastMsgAt = new Date().toISOString();
    logLine("LOG", `RX: ${txt.slice(0, 400)}${txt.length > 400 ? " …" : ""}`);

    let obj = null;
    try { obj = JSON.parse(txt); } catch { /* ignore non-JSON */ }

    if (obj?.error) {
      logLine("ERR", `AISstream error: ${obj.error}`);
      return;
    }

    // MMSI i MetaData (docs)
    const mm = obj?.MetaData?.MMSI ? String(obj.MetaData.MMSI) : null;
    if (!mm || !MMSI_STR.includes(mm)) return;

    // Position kan ligga i Message.PositionReport eller i Message
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
        ts: obj?.MetaData?.time_utc || lastMsgAt
      });
    }
  });

  ws.on("close", () => {
    logLine("ERR", "WS closed. Reconnecting in 5s…");
    clearInterval(pingTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    logLine("ERR", `WS error: ${e?.message || e}`);
    try { ws.close(); } catch {}
  });
}
connect();

/* ========= HTTP ========= */
const app = express();

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/positions", (req, res) => {
  const out = {};
  MMSI_STR.forEach(mm => { out[mm] = latest.get(mm) || null; });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});

app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ apiKeyLoaded: !!API_KEY, msgCount, lastMsgAt, have: Array.from(latest.keys()) });
});

app.get("/peek", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("application/json").send(lastRaw || '{"info":"No data yet"}');
});

app.get("/logs", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("text/plain").send(ring.join("\n"));
});

app.listen(PORT, () => logLine("LOG", `HTTP listening on ${PORT}`));

