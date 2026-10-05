const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Enable JSON body parsing for API endpoints
app.use(express.json());

const MILEAGE_RATE = 0.725; // 2026 IRS Rate

// PERSISTENT SERVER STATE STORAGE
let shortcutStartMiles = null;
let shortcutMaxRange = null;

let lastKnownAltitudeMeters = null;
let accumulatedTerrainAdjustmentMiles = 0.0; 

// BASELINE SNAPSHOTS FOR RESETS
let rangeDistanceBaseline = 0.0; 
let sessionMilesBaseline = 0.0;
let latestRawDistanceMiles = 0.0;

// SHIFT TIMER STATE (SERVER-SIDE)
let shiftStartTime = null;

// TORQUE AUTO-RESET GUARD STATE
let savedPreviousTripsMiles = 0.0;
let lastKnownRawMiles = 0.0;

// STICKY GPS STORAGE: Default to Pacifica
let currentLat = 37.6017; 
let currentLon = -122.4868;

// ==========================================
// AI VISION OFFER CARD PROCESSOR (REST API)
// ==========================================
async function processOfferCard() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const dbxToken = process.env.DROPBOX_ACCESS_TOKEN;

    if (!apiKey) throw new Error('GEMINI_API_KEY missing on Render');
    if (!dbxToken) throw new Error('DROPBOX_ACCESS_TOKEN missing on Render');

    console.log('Fetching /offercard.png from Dropbox via REST...');

    // 1. Download image directly via Dropbox Content API
    const dbxDownloadRes = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${dbxToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: '/offercard.png' })
      }
    });

    if (!dbxDownloadRes.ok) {
      const errText = await dbxDownloadRes.text();
      console.error('DROPBOX_DOWNLOAD_ERROR:', errText);
      throw new Error(`Dropbox Download Error [${dbxDownloadRes.status}]: ${errText}`);
    }

    const arrayBuffer = await dbxDownloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString('base64');

    let mimeType = 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      mimeType = 'image/jpeg';
    }

    console.log('Sending image to Gemini via REST...');

    // 2. Call Gemini 2.5 Flash API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType, data: base64Data } },
              { text: 'Extract the offer payout price (as a number) and total miles (as a number) from this screenshot. Return strictly valid raw JSON without markdown formatting in this exact shape: {"price": 15.20, "miles": 6.2}' }
            ]
          }
        ]
      })
    });

    const resData = await response.json();

    if (!response.ok) {
      console.error('GOOGLE_RAW_ERROR:', JSON.stringify(resData));
      throw new Error(`Google Error [${response.status}]: ${resData.error?.message || 'Bad Request'}`);
    }

    const responseText = resData.candidates[0].content.parts[0].text;
    const cleanJson = responseText.replace(/```json\s*|
