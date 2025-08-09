import express from "express";
import { WebSocket } from "ws";

// ========= Config =========
const PORT = process.env.PORT || 3000;
// Du kan låta env-variabel vara tom – vi har fallback till din nyckel:
const API_KEY = process.env.AIS_API_KEY || "e5cd993650ca18fa4924f1b0da684e89a642c964";

// Bit Power & Bit Force (heltal!)
const MMSI_LIST = [244944000, 244813000];

// Lagrar senaste position per MMSI
const latest = new Map();
let ws, pingTimer, msgCount = 0, lastMsgAt = null;

// Bygg en post av inkommande meddelande
function buildPositionEntry(msg) {
  const meta = msg?.MetaData || {};
  const mmsi =
    Number(meta.MMSI || msg?.Message?.UserID || msg?.Message?.MMSI || msg?.MMSI);
  if (!mmsi) return null;

  const pr = msg?.Message?.PositionReport || msg?.Message || {};
  const lat = pr.Latitude ?? pr.Lat ?? null;
  const lon = pr.Longitude ?? pr.Lon ?? null;
  const sog = pr.Sog ?? pr.SOG ?? pr.SpeedOverGround ?? null;
  const nav = pr.NavigationalStatus ?? pr.NavigationStatus ?? null;

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
    console.log("WS open, sending subscribe…");
    // Viktigt: använd ENBART MMSI-filter. (Vissa kombinationer med BoundingBoxes gör att det inte levereras något.)
    const sub = {
      APIKey: API_KEY,
      FiltersShipMMSI: MMSI_LIST,         // heltal
      MessageTypes: ["PositionReport"]    // bara positionsrapporter
    };
    ws.send(JSON.stringify(sub));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { ws.ping?.(); } catch {} }, 25000);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      msgCount++; lastMsgAt = new Date().toISOString();

      // Extrakoll – vissa payloads har typnamn
      const typ = msg?.Message?.Type || msg?.Message?.MessageType;
      if (typ && !/PositionReport/i.test(typ)) return;

      const entry = buildPositionEntry(msg);
      if (entry && MMSI_LIST.includes(Number(entry.mmsi))) {
        latest.set(entry.mmsi, entry);
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

// ========= HTTP =========
const app = express();
app.get("/", (req, res) => res.json({ ok: true }));
app.get("/positions", (req, res) => {
  const out = {};
  MMSI_LIST.forEach(mm => { out[String(mm)] = latest.get(String(mm)) || null; });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});
// enkel debug-endpoint
app.get("/debug", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    apiKeyLoaded: !!API_KEY,
    msgCount,
    lastMsgAt,
    have: Array.from(latest.keys())
  });
});

app.listen(PORT, () => console.log("HTTP listening on", PORT));

});

app.listen(PORT, () => console.log("HTTP listening on", PORT));
