import express from "express";
import { WebSocket } from "ws";

// --- Config ---
const PORT = process.env.PORT || 3000;
// Låt denna rad stå så här. Om du hellre vill hårdkoda nyckeln: ersätt hela raden med const API_KEY = "DIN_NYCKEL";
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// Bit Power & Bit Force (heltal! – viktigt för AISstream-filtrering)
const MMSI_LIST = [244944000, 244813000];

// Senaste kända läge per MMSI
const latest = new Map();

let ws;
let pingTimer;

// Bygg en säker positions-post från ett PositionReport
function buildPositionEntry(msg) {
  const meta = msg?.MetaData || {};
  const mmsi = Number(meta.MMSI || msg?.Message?.UserID || msg?.Message?.MMSI);
  if (!mmsi) return null;

  // I AISstream är själva positionen i Message.PositionReport eller direkt i Message
  const m = msg?.Message?.PositionReport || msg?.Message || {};

  const lat = m.Latitude ?? m.Lat ?? null;
  const lon = m.Longitude ?? m.Lon ?? null;
  const sog = m.Sog ?? m.SOG ?? m.SpeedOverGround ?? null;
  const nav = m.NavigationalStatus ?? m.NavigationStatus ?? null;

  return {
    mmsi: String(mmsi),
    lat, lon,
    sogKnots: sog,
    navStatus: nav,
    ts: meta.time_utc || new Date().toISOString()
  };
}

function connect() {
  console.log("Connecting to AISstream…");
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    console.log("WS open, subscribing…");
    const sub = {
      APIKey: API_KEY,
      // Global bbox
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      // Viktigt: heltal, och rätt fältnamn
      FiltersShipMMSI: MMSI_LIST,
      // Begränsa till positionsrapporter
      MessageTypes: ["PositionReport"]
    };
    ws.send(JSON.stringify(sub));

    // Keep-alive ping (Render gratis kan stänga inaktiva WS)
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try { ws.ping?.(); } catch {}
    }, 25000);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Bara positioner (vi bad om MessageTypes: PositionReport, men extra check skadar inte)
      const type = msg?.Message?.Type || msg?.Message?.MessageType;
      if (type && !/PositionReport/i.test(type)) return;

      const entry = buildPositionEntry(msg);
      if (entry && MMSI_LIST.includes(Number(entry.mmsi))) {
        latest.set(entry.mmsi, entry);
      }
    } catch (e) {
      console.error("parse error:", e);
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

// --- HTTP API ---
const app = express();
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/positions", (req, res) => {
  // Returnera alltid båda MMSI:erna, null om inget mottaget ännu
  const out = {};
  MMSI_LIST.forEach((mm) => {
    const k = String(mm);
    out[k] = latest.get(k) || null;
  });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});

app.listen(PORT, () => console.log("HTTP listening on", PORT));
