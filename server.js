import express from "express";

// --- Konfig ---
const PORT = process.env.PORT || 3000;

// Din AIS-proxy (Render-servicen du redan kör)
const AIS_PROXY_URL = "https://tarbitaisproxy.onrender.com/positions";

// Cache i minnet – så senaste kända data ligger kvar
let latestData = {};
let lastUpdated = null;

// Hämtar från proxyn och uppdaterar cachen
async function updateAISData() {
  try {
    const res = await fetch(AIS_PROXY_URL, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Bad status ${res.status}`);
    const json = await res.json();

    if (json && typeof json === "object" && Object.keys(json).length > 0) {
      latestData = json;
      lastUpdated = new Date().toISOString();
      console.log("[AIS] Data updated", lastUpdated);
    } else {
      console.log("[AIS] No new data, keeping previous cache");
    }
  } catch (err) {
    console.error("[AIS] Fetch error:", err.message || err);
  }
}

// Polla var 2:e minut
setInterval(updateAISData, 120000);
updateAISData();

// --- HTTP ---
const app = express();

// CORS för att Netlify ska kunna hämta
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/", (req, res) => {
  res.json({ ok: true, lastUpdated });
});

// Frontend kan hämta här
app.get("/positions", (req, res) => {
  res.json({
    lastUpdated,
    positions: latestData
  });
});

app.listen(PORT, () => {
  console.log("HTTP listening on", PORT);
});
