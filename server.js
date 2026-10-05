const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// AI & Dropbox SDK Imports
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Dropbox } = require('dropbox');

// Enable JSON body parsing for API endpoints
app.use(express.json());

// Initialize Gemini SDK with API key from Render Environment
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
// AI VISION OFFER CARD PROCESSOR (GEMINI)
// ==========================================
async function processOfferCard() {
  try {
    // Initialize Dropbox client using token from Render environment variables
    const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });

    console.log('Fetching /offercard.png from Dropbox...');
    
    // 1. Download offercard.png from Dropbox
    const dbxResponse = await dbx.filesDownload({ path: '/offercard.png' });
    const imageBuffer = dbxResponse.result.fileBinary;

    // 2. Send image buffer to Gemini 1.5 Flash
    console.log('Sending image to Gemini 1.5 Flash...');
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const response = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/png',
          data: imageBuffer.toString('base64')
        }
      },
      `You are an assistant for a delivery driver live stream.
       Look at this delivery offer card (DoorDash, Uber Eats, or Instacart).
       Extract:
       1. Main offer payout price (e.g. 15.20)
       2. Total trip distance in miles (e.g. 6.2)

       Ignore tip breakdowns, batch sub-totals, map street numbers, and highway markers.
       Return ONLY raw JSON in this format:
       {"price": 15.20, "miles": 6.2}`
    ]);

    // 3. Clean and parse JSON response
    const responseText = response.response.text();
    const cleanJson = responseText.replace(/```json|
