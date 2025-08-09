import express from "express";
import { WebSocket } from "ws";

/* ========== Konfig ========== */
const PORT = process.env.PORT || 3000;
// Miljövariabel om du har – annars fallback till din nyckel:
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// Bit Power & Bit Force – som STRÄNGAR (AISstream kräver det i filtret)
const MMSI_STR = ["244944000", "244813000"];

/* ========== State ========== */
const latest = new Map();        // mmsi -> { lat, lon, sogKnots, navStatus, ts }
let ws;                          // WebSocket
let pingTimer;                   // keep-alive
let msgCount = 0;
let lastMsgAt = null;
let lastRaw = "";                // senaste råa meddelandet (för /peek)

/* ========== WS-anslutning ========== */
function connect() {
  console.log("Connecting to AISstream…");
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    console.log("WS open, sending subscribe…");

    // Viktigt: MMSI som STRÄNGAR + global BoundingBox.
    // Börja med att bara be om PositionReport. Om du mot
    // förmodan får 'Malformed' i /peek, testa att ta bort MessageTypes.
    const sub = {
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: MMSI_STR,
      MessageTypes: ["PositionReport"]
    };

    console.log("Subscribe object:", JSON.stringify(sub));
    ws.send(JSON.stringify(sub));

    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    const txt = raw.toString();
    lastRaw = txt;                         // spara för /peek

    try {
      const msg = JSON.parse(txt);
      msgCount++;
      lastMsgAt = new Date().toISOString();

      // AISstream kan skicka fel som { error: "..." }
      if (msg?.error) {
        console.error("AISstream error:", msg.error);
        return;
      }

      // MMSI sitter i MetaData.MMSI
      const mm = String(msg?.MetaData?.MMSI || "");
      if (!mm || !MMSI_STR.includes(mm)) return;

      // Plocka ut bästa fälten vi kan hitta
      const m = msg?.Message?.PositionReport || msg?.Message || {};
      const lat = m.Latitude ?? m.Lat ?? null;
      const lon = m.Longitude ?? m.Lon ?? null;
      const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
      const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

      // Spara om vi har nån nyttig data
      if (lat != null || lon != null || sog != null) {
        latest.set(mm, {
          mmsi: mm,
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

/* ========== HTTP API ========== */
const app = express();

// Hälsokoll
app.get("/", (req, res) => res.json({ ok: true }));

// Senaste positioner
app.get("/positions", (req, res) => {
  const out = {};
  MMSI_STR.forEach(mm => { out[mm] = latest.get(mm) || null; });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});

// Debug-info
app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    apiKeyLoaded: !!API_KEY,
    msgCount,
    lastMsgAt,
    have: Array.from(latest.keys())
  });
});

// Titta på senaste råa meddelandet (bra vid fel som "Malformed")
app.get("/peek", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.type("application/json").send(lastRaw || '{"info":"No data yet"}');
});

app.listen(PORT, () => console.log("HTTP listening on", PORT));
