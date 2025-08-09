import express from "express";
import { WebSocket } from "ws";

// ========= Config =========
const PORT = process.env.PORT || 3000;
// Ladda API-nyckeln från Render environment eller fallback
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// Ditt MMSI-filter
const MMSI_LIST = [244944000, 244813000];

// Lagrar senaste position per MMSI
const latest = new Map();
let ws, pingTimer, msgCount = 0, lastMsgAt = null;

// Anslut till AISstream
function connect() {
  console.log("Connecting to AISstream…");
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    console.log("WS open, sending subscribe…");
    const sub = {
      APIKey: API_KEY,
      FiltersShipMMSI: MMSI_LIST // bara MMSI, inga MessageTypes
    };
    ws.send(JSON.stringify(sub));

    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      msgCount++;
      lastMsgAt = new Date().toISOString();

      const mm = Number(msg?.MetaData?.MMSI);
      if (!mm || !MMSI_LIST.includes(mm)) return;

      const m = msg?.Message?.PositionReport || msg?.Message || {};
      const lat = m.Latitude ?? m.Lat ?? null;
      const lon = m.Longitude ?? m.Lon ?? null;
      const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
      const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

      if (lat != null || lon != null || sog != null) {
        latest.set(String(mm), {
          mmsi: String(mm),
          lat, lon,
          sogKnots: sog,
          navStatus: nav,
          ts: msg?.MetaData?.time_utc || new Date().toISOString()
        });
      }
    } catch (e) {
      console.error("parse error:", e?.message || e);
    }
  });

  ws.on("close", () => {
    console.warn("WS closed, reconnecting in 5s…");
    clearInterval(pingTimer);
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    console.error("WS error:", e?.message || e);
    try { ws.close(); } catch {}
  });
}

connect();

// ========= HTTP API =========
const app = express();

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/positions", (req, res) => {
  const out = {};
  MMSI_LIST.forEach(mm => { out[String(mm)] = latest.get(String(mm)) || null; });
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

// Extra endpoint för att titta på senaste råa meddelandet (för felsökning)
let lastRaw = null;
ws?.on?.("message", (raw) => { lastRaw = raw.toString(); });
app.get("/peek", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(lastRaw || "No data yet");
});

app.listen(PORT, () => console.log("HTTP listening on", PORT));


