import express from "express";
import fetch from "node-fetch";

const PORT = process.env.PORT || 3000;

// Din AIS-proxy
const AIS_PROXY_URL = "https://tarbitaisproxy.onrender.com/positions";

// Här sparas senaste kända data
let latestData = {};
let lastUpdated = null;

// Funktion för att hämta och lagra data från proxyn
async function updateAISData() {
    try {
        const res = await fetch(AIS_PROXY_URL);
        const json = await res.json();

        if (json && Object.keys(json).length > 0) {
            latestData = json;
            lastUpdated = new Date().toISOString();
            console.log("Uppdaterade AIS-data:", latestData);
        } else {
            console.log("Ingen ny data från AIS, behåller senaste");
        }
    } catch (err) {
        console.error("Fel vid hämtning av AIS-data:", err);
    }
}

// Hämta data var 2:e minut
setInterval(updateAISData, 120000);
updateAISData();

// Starta servern
const app = express();

// Statuskontroll
app.get("/", (req, res) => {
    res.json({ status: "ok", lastUpdated });
});

// Endpoint som frontend kan hämta
app.get("/positions", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        lastUpdated,
        positions: latestData
    });
});

app.listen(PORT, () => {
    console.log(`HTTP server körs på port ${PORT}`);
});

