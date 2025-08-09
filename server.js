import express from "express";
import { WebSocket } from "ws";
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.AIS_API_KEY || "REPLACE_WITH_YOUR_KEY";
const MMSI_LIST = ["244944000","244813000"];
const latest = new Map();
let ws;
function connect(){
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  ws.on("open", ()=>{ ws.send(JSON.stringify({ APIKey: API_KEY, BoundingBoxes: [[[-90,-180],[90,180]]], FiltersShipMMSI: MMSI_LIST })); });
  ws.on("message", (raw)=>{
    try{
      const msg = JSON.parse(raw.toString());
      const mmsi = msg?.MetaData?.MMSI || msg?.Message?.UserID || msg?.Message?.MMSI;
      const pos = msg?.Message?.PositionReport || msg?.Message;
      const nav = msg?.Message?.NavigationStatus || msg?.Message?.NavigationalStatus;
      const sog = pos?.Sog || pos?.SOG || pos?.SpeedOverGround;
      const lat = pos?.Latitude || pos?.Lat;
      const lon = pos?.Longitude || pos?.Lon;
      if(mmsi) latest.set(String(mmsi), { mmsi:String(mmsi), navStatus:nav??null, sogKnots:sog??null, lat:lat??null, lon:lon??null, ts: msg?.MetaData?.time_utc || new Date().toISOString() });
    }catch{}
  });
  ws.on("close", ()=> setTimeout(connect, 5000));
  ws.on("error", ()=>{ try{ ws.close(); }catch{} });
}
connect();
const app = express();
app.get("/", (req,res)=> res.json({ ok:true }));
app.get("/positions", (req,res)=>{ const out={}; MMSI_LIST.forEach(mm=> out[mm]=latest.get(mm) || null); res.setHeader("Access-Control-Allow-Origin","*"); res.json(out); });
app.listen(PORT, ()=> console.log("HTTP on", PORT));
