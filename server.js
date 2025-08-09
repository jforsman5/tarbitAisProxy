import express from "express";
import { WebSocket } from "ws";

/* ========= Config ========= */
const PORT = process.env.PORT || 3000;
// Din nyckel: läses från env om den finns, annars fallback till din
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// MMSI som STRÄNGAR (kräsna API:n gillar det bäst)
const MMSI = ["244944000", "244813000"];

/* ========= State ========= */
const latest = new Map();            // mmsi -> { lat, lon, sogKnots, navStatus, ts }
let ws;
let pingTimer;
let reconnectTimer;
let msgCount = 0;
let lastMsgAt = null;

// Cirkulär logg (för /logs)
const MAX_LOG = 50;
const ring = [];
const logLine = (level, text) => {
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  console[level === "ERR" ? "error" : "log"](line);
  ring.push(line);
  if (ring.length > MAX_LOG) ring.shift();
};

// Spara senaste råa meddelandet (för /peek)
let lastRaw = "";

/* ========= Connect ========= */
function connect() {
  logLine("LOG", "Connecting to AISstream…");
  try { if (ws) ws.close(); } catch {}
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);

  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    logLine("LOG", "WS open. Sending subscribe (MMSI only) …");
    const sub = {
      APIKey: API_KEY,
      // Minimal & tolerant – endast MMSI-filter
      FiltersShipMMSI: MMSI
      // Om detta inte ger något kan vi lägga till BoundingBoxes/MessageTypes senare
    };
    const payload = JSON.stringify(sub);
    logLine("LOG", `Subscribe payload: ${payload}`);
    ws.send(payload);

    pingTimer = setInterval(() => {
      try { ws.ping?.(); } catch {}
    }, 25000);
  });

  ws.on("message", (raw) => {
    const txt = raw.toString();
    lastRaw = txt;
    msgCount++;
    lastMsgAt = new Date().toISOString();

    // Logga *allt* vi får (trimma till 400 tecken så inte loggen svämmar över)
    logLine("LOG", `RX: ${txt.slice(0, 400)}${txt.length>400 ? " …" : ""}`);

    // En del fel kommer som { "error": "..." }
    try {
      const obj = JSON.parse(txt);

      if (obj && obj.error) {
        logLine("ERR", `AISstream error: ${obj.error}`);
        return;
      }

      const mm = obj?.MetaData?.MMSI ? String(obj.MetaData.MMSI) : null;
      if (!mm || !MMSI.includes(mm)) return;

      const m = obj?.Message?.PositionReport || obj?.Message || {};
      const lat = m.Latitude ?? m.Lat ?? null;
      const lon = m.Longitude ?? m.Lon ?? null;
      const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
      const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

      if (lat != null || lon != null || sog != null) {
        latest.set(mm, {
          mmsi: mm, lat, lon, sogKnots: sog, navStatus: nav,
          ts: obj?.MetaData?.time_utc || lastMsgAt
        });
      }
    } catch (e) {
      // Om inte JSON – låt loggen visa råtexten ändå
      logLine("ERR", `parse error: ${e?.message || e}`);
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
  MMSI.forEach(mm => { out[mm] = latest.get(mm) || null; });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});

app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    apiKeyLoaded: !!API_KEY,
    msgCount,
    lastMsgAt,
    have: Array.from(latest.keys())
  });
});

app.get("/peek", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("application/json").send(lastRaw || '{"info":"No data yet"}');
});

// Läs de senaste 50 loggraderna direkt i webbläsaren
app.get("/logs", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("text/plain").send(ring.join("\n"));
});

app.listen(PORT, () => logLine("LOG", `HTTP listening on ${PORT}`));

