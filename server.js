import express from "express";
import { WebSocket } from "ws";

/* ========= Config ========= */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// Bit Power & Bit Force – som STRÄNGAR
const MMSI = ["244944000", "244813000"];

/* ========= State ========= */
const latest = new Map();
let ws;
let pingTimer;
let msgCount = 0;
let lastMsgAt = null;
let lastRaw = "";

/* ========= Connect ========= */
function connect() {
  console.log("Connecting to AISstream…");
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    console.log("WS open, sending minimal subscribe (MMSI only) …");
    // *** MINIMAL SUBSCRIBE: bara MMSI-filter ***
    const sub = {
      APIKey: API_KEY,
      FiltersShipMMSI: MMSI
      // Inga BoundingBoxes, inga MessageTypes
    };
    console.log("Subscribe object:", JSON.stringify(sub));
    ws.send(JSON.stringify(sub));

    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    const txt = raw.toString();
    lastRaw = txt; // för /peek

    // Vissa server-svar kan vara plain text, så fånga JSON försiktigt
    let obj = null;
    try { obj = JSON.parse(txt); } catch { /* ignore */ }

    // Logga ev. fel från servern
    if (obj && obj.error) {
      console.error("AISstream error:", obj.error);
      return;
    }

    msgCount++;
    lastMsgAt = new Date().toISOString();

    // MMSI sitter i MetaData.MMSI
    const mm = obj?.MetaData?.MMSI ? String(obj.MetaData.MMSI) : null;
    if (!mm || !MMSI.includes(mm)) return;

    // Försök plocka position/fart/status ur olika fält
    const m = obj?.Message?.PositionReport || obj?.Message || {};
    const lat = m.Latitude ?? m.Lat ?? null;
    const lon = m.Longitude ?? m.Lon ?? null;
    const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
    const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

    if (lat != null || lon != null || sog != null) {
      latest.set(mm, {
        mmsi: mm,
        lat, lon,
        sogKnots: sog,
        navStatus: nav,
        ts: obj?.MetaData?.time_utc || new Date().toISOString()
      });
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

app.listen(PORT, () => console.log("HTTP listening on", PORT));
