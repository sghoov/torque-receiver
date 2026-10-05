const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Enable JSON body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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

// DROPBOX HELPER FUNCTIONS
async function downloadFromDropbox(dbxToken, filePath) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${dbxToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: filePath })
    }
  });
  if (!res.ok) return null;
  return await res.text();
}

async function uploadToDropbox(dbxToken, filePath, contentString) {
  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${dbxToken}`,
      'Dropbox-API-Arg': JSON.stringify({
        path: filePath,
        mode: 'overwrite',
        autorename: false,
        mute: false
      }),
      'Content-Type': 'application/octet-stream'
    },
    body: contentString
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error(`Dropbox Upload Error for ${filePath}:`, errText);
  }
}

// ==========================================
// AI VISION OFFER CARD PROCESSOR (REST API)
// ==========================================
async function processOfferCard(isSubtractMode = false) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const dbxToken = process.env.DROPBOX_ACCESS_TOKEN;

    if (!apiKey) throw new Error('GEMINI_API_KEY missing on Render');
    if (!dbxToken) throw new Error('DROPBOX_ACCESS_TOKEN missing on Render');

    console.log('Fetching /offercard.png from Dropbox via REST...');

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

    console.log('Sending image to Gemini 3.8 Flash via REST...');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

    const promptText = `
      Extract the details from this delivery offer screenshot.
      Return strictly valid raw JSON without markdown formatting in this exact shape:
      {
        "price": 15.20,
        "miles": 6.2,
        "store_name": "Store or Restaurant Name",
        "app_name": "DoorDash", 
        "pickup_count": 1,
        "dropoff_count": 1,
        "is_stacked": false
      }
      Notes:
      - app_name must be one of: "DoorDash", "Uber Eats", "Grubhub", "Amazon Flex", or "Other".
      - If there are multiple pickups or dropoffs (stacked offer), set is_stacked to true and count them.
      - If store_name is not visible, use "Unknown Merchant".
    `;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType, data: base64Data } },
              { text: promptText }
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
    const cleanJson = responseText.replace(/```json\s*|```/g, '').trim();
    const data = JSON.parse(cleanJson);

    // Read current shift_stats.json from Dropbox (or create default)
    let stats = {
      totals: { earnings: 0, miles: 0, deliveries: 0 },
      apps: {
        doordash: { earnings: 0, miles: 0, deliveries: 0 },
        ubereats: { earnings: 0, miles: 0, deliveries: 0 },
        grubhub: { earnings: 0, miles: 0, deliveries: 0 },
        other: { earnings: 0, miles: 0, deliveries: 0 }
      },
      history: []
    };

    const existingStatsText = await downloadFromDropbox(dbxToken, '/shift_stats.json');
    if (existingStatsText) {
      try { stats = JSON.parse(existingStatsText); } catch (e) {}
    }

    const appKey = (data.app_name || 'other').toLowerCase().replace(/\s+/g, '');
    const activeApp = stats.apps[appKey] ? appKey : 'other';

    let offerPrice = parseFloat(data.price) || 0;
    let offerMiles = parseFloat(data.miles) || 0;

    if (isSubtractMode) {
      // Subtraction Mode: Deduct price and miles
      stats.totals.earnings = Math.max(0, stats.totals.earnings - offerPrice);
      stats.totals.miles = Math.max(0, stats.totals.miles - offerMiles);
      stats.totals.deliveries = Math.max(0, stats.totals.deliveries - 1);

      stats.apps[activeApp].earnings = Math.max(0, stats.apps[activeApp].earnings - offerPrice);
      stats.apps[activeApp].miles = Math.max(0, stats.apps[activeApp].miles - offerMiles);
      stats.apps[activeApp].deliveries = Math.max(0, stats.apps[activeApp].deliveries - 1);

      stats.history.push({
        type: "REMOVAL",
        timestamp: new Date().toISOString(),
        store: data.store_name,
        app: data.app_name,
        price: -offerPrice,
        miles: -offerMiles
      });
    } else {
      // Addition Mode: Accumulate price and miles
      stats.totals.earnings += offerPrice;
      stats.totals.miles += offerMiles;
      stats.totals.deliveries += 1;

      stats.apps[activeApp].earnings += offerPrice;
      stats.apps[activeApp].miles += offerMiles;
      stats.apps[activeApp].deliveries += 1;

      stats.history.push({
        type: "ADDITION",
        timestamp: new Date().toISOString(),
        store: data.store_name,
        app: data.app_name,
        price: offerPrice,
        miles: offerMiles,
        is_stacked: data.is_stacked,
        pickups: data.pickup_count,
        dropoffs: data.dropoff_count
      });
    }

    // Save outputs back to Dropbox
    await uploadToDropbox(dbxToken, '/shift_stats.json', JSON.stringify(stats, null, 2));
    await uploadToDropbox(dbxToken, '/total.txt', stats.totals.earnings.toFixed(2));
    await uploadToDropbox(dbxToken, '/offer_miles.txt', stats.totals.miles.toFixed(1));
    await uploadToDropbox(dbxToken, `/app_${activeApp}_total.txt`, stats.apps[activeApp].earnings.toFixed(2));

    return {
      success: true,
      action: isSubtractMode ? "SUBTRACTED" : "ADDED",
      offer: {
        price: offerPrice,
        miles: offerMiles,
        store: data.store_name,
        app: data.app_name,
        is_stacked: data.is_stacked,
        pickups: data.pickup_count,
        dropoffs: data.dropoff_count
      },
      totals: {
        total_earnings: stats.totals.earnings.toFixed(2),
        total_miles: stats.totals.miles.toFixed(1),
        app_earnings: stats.apps[activeApp].earnings.toFixed(2)
      }
    };

  } catch (err) {
    console.error('Error in processOfferCard:', err.message);
    throw err;
  }
}

// Function to undo/revert the last offer entry
async function undoLastOffer() {
  const dbxToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (!dbxToken) throw new Error('DROPBOX_ACCESS_TOKEN missing');

  const existingStatsText = await downloadFromDropbox(dbxToken, '/shift_stats.json');
  if (!existingStatsText) throw new Error('No shift stats found on Dropbox.');

  let stats = JSON.parse(existingStatsText);
  if (!stats.history || stats.history.length === 0) {
    throw new Error('No offer history available to undo.');
  }

  // Pop the last entry
  const lastEntry = stats.history.pop();
  const appKey = (lastEntry.app || 'other').toLowerCase().replace(/\s+/g, '');
  const activeApp = stats.apps[appKey] ? appKey : 'other';

  const price = Math.abs(lastEntry.price || 0);
  const miles = Math.abs(lastEntry.miles || 0);

  if (lastEntry.type === "ADDITION") {
    stats.totals.earnings = Math.max(0, stats.totals.earnings - price);
    stats.totals.miles = Math.max(0, stats.totals.miles - miles);
    stats.totals.deliveries = Math.max(0, stats.totals.deliveries - 1);

    stats.apps[activeApp].earnings = Math.max(0, stats.apps[activeApp].earnings - price);
    stats.apps[activeApp].miles = Math.max(0, stats.apps[activeApp].miles - miles);
    stats.apps[activeApp].deliveries = Math.max(0, stats.apps[activeApp].deliveries - 1);
  }

  await uploadToDropbox(dbxToken, '/shift_stats.json', JSON.stringify(stats, null, 2));
  await uploadToDropbox(dbxToken, '/total.txt', stats.totals.earnings.toFixed(2));
  await uploadToDropbox(dbxToken, '/offer_miles.txt', stats.totals.miles.toFixed(1));
  await uploadToDropbox(dbxToken, `/app_${activeApp}_total.txt`, stats.apps[activeApp].earnings.toFixed(2));

  return { success: true, undoneEntry: lastEntry, newTotal: stats.totals.earnings.toFixed(2) };
}

// ==========================================
// ROUTES
// ==========================================

app.get('/', (req, res) => {
    res.send('Telemetry physics engine & AI Vision server is up and running safely!');
});

// Route to process offer cards (supports query parameter ?subtract=true)
app.post('/process-card', async (req, res) => {
  try {
    const isSubtract = req.query.subtract === 'true' || (req.body && req.body.subtract === true);
    const result = await processOfferCard(isSubtract);
    res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('API /process-card failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Route to undo the last scanned offer card
app.post('/undo-offer', async (req, res) => {
  try {
    const result = await undoLastOffer();
    res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('API /undo-offer failed:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/current-city', (req, res) => {
    res.json({ lat: currentLat, lon: currentLon });
});

app.get('/update-range', (req, res) => {
    try {
        if (req.query.fullReset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            savedPreviousTripsMiles = 0.0;
            lastKnownRawMiles = 0.0;
            shiftStartTime = null;
            rangeDistanceBaseline = latestRawDistanceMiles;
            sessionMilesBaseline = latestRawDistanceMiles;

            io.emit('shift_reset');
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            return res.send(`Success: Full shift clock, session miles, and range reset to 0!`);
        }

        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            rangeDistanceBaseline = latestRawDistanceMiles;

            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            return res.send(`Success: Range bar reset to 70mi!`);
        }

        let parsedStart = parseFloat(req.query.startMiles);
        let parsedRange = parseFloat(req.query.maxRange);
        if (!isNaN(parsedStart)) shortcutStartMiles = parsedStart;
        if (!isNaN(parsedRange)) shortcutMaxRange = parsedRange;

        if (!isNaN(parsedStart) || !isNaN(parsedRange)) {
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });
            return res.send(`Updated! Start Miles: ${shortcutStartMiles}, Max Range: ${shortcutMaxRange}`);
        }
        return res.status(400).send('Error: No valid numeric parameters received.');
    } catch (error) {
        console.error('Shortcut endpoint error:', error.message);
        res.status(500).send('Error handled safely.');
    }
});

app.get('/live', async (req, res) => {
    try {
        const getParam = (key) => {
            let val = req.query[key] || req.query[key.toUpperCase()] || req.query[key.toLowerCase()];
            if (Array.isArray(val)) val = val[0];
            if (val === undefined || val === null || val === "" || isNaN(parseFloat(val))) return null;
            return parseFloat(val);
        };

        let rawSpeedKmh = getParam('kff1001') || 0;
        let speedMph = rawSpeedKmh * 0.621371;
        if (isNaN(speedMph) || speedMph < 0.8 || speedMph > 110) speedMph = 0;

        if (speedMph > 1.0 && shiftStartTime === null) {
            shiftStartTime = Date.now();
        }

        let shiftDurationSeconds = shiftStartTime ? Math.floor((Date.now() - shiftStartTime) / 1000) : 0;

        let incomingDistanceKm = getParam('kff1204');
        let rawTripDistanceMiles = lastKnownRawMiles;

        if (incomingDistanceKm !== null) {
            let parsedMiles = incomingDistanceKm * 0.621371;
            
            if (!isNaN(parsedMiles) && parsedMiles > 0.01) {
                if (lastKnownRawMiles > 0 && parsedMiles > (lastKnownRawMiles + 5.0)) {
                    rawTripDistanceMiles = lastKnownRawMiles;
                } 
                else if (lastKnownRawMiles > 1.0 && parsedMiles < 0.5) {
                    savedPreviousTripsMiles += Math.max(0, lastKnownRawMiles - sessionMilesBaseline);
                    sessionMilesBaseline = 0.0;
                    rangeDistanceBaseline = 0.0;
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                } 
                else if (parsedMiles >= lastKnownRawMiles) {
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                }
            }
        }

        latestRawDistanceMiles = rawTripDistanceMiles;

        let currentUnweightedMiles = Math.max(0, rawTripDistanceMiles - sessionMilesBaseline);
        let trueSessionMiles = savedPreviousTripsMiles + currentUnweightedMiles;
        if (isNaN(trueSessionMiles)) trueSessionMiles = 0.0;

        let milesOnCurrentCharge = Math.max(0, rawTripDistanceMiles - rangeDistanceBaseline);
        let taxSaved = trueSessionMiles * MILEAGE_RATE;

        let hwyPercent = getParam('kff1297') || 0;
        let motorTorque = getParam('kff1225') || 0;

        let speedPenalty = 0.0;
        if (speedMph > 53) {
            speedPenalty = Math.min(0.18, ((speedMph - 53) / 17) * 0.18); 
        }
        let hwyPenalty = (hwyPercent / 100) * 0.10; 
        let styleMultiplier = 1.0 + speedPenalty + hwyPenalty;

        let baseWeightedMiles = (milesOnCurrentCharge * styleMultiplier) * 1.05;

        let rawAltitudeMeters = getParam('kff1010');
        
        if (speedMph > 2 && rawAltitudeMeters !== null) {
            if (lastKnownAltitudeMeters !== null && !isNaN(lastKnownAltitudeMeters)) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;
                
                if (deltaFeet > 3.0 && deltaFeet < 120.0) { 
                    let climbWeight = deltaFeet * 0.005; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            if (motorTorque <= 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.20; 
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        }

        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (isNaN(adjustedTripDistanceMiles) || adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; 

        let rawAmbientCelsius = getParam('k46');
        let tempFahrenheit = "--°F";
        if (rawAmbientCelsius !== null) {
            tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
        }

        let elevationDisplay = "-- ft";
        if (rawAltitudeMeters !== null) {
            let trueFeet = (rawAltitudeMeters * 3.28084) + 104; 
            elevationDisplay = Math.round(trueFeet) + " ft";
        }

        let rawBearing = getParam('kff123b');
        let compassHeading = "--";
        if (rawBearing !== null) {
            const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            let index = Math.round(((rawBearing % 360) / 45)) % 8;
            compassHeading = directions[index];
        }

        let latIn = getParam('kff1006');
        if (latIn !== null && latIn !== 0) currentLat = latIn;

        let lonIn = getParam('kff1005');
        if (lonIn !== null && lonIn !== 0) currentLon = lonIn;

        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", 
            speed: Math.round(speedMph) + " mph",
            elevation: elevationDisplay, 
            temperature: tempFahrenheit,
            compass: compassHeading,
            lat: currentLat, 
            lon: currentLon,
            tripMilesRaw: adjustedTripDistanceMiles,
            actualSessionMilesRaw: trueSessionMiles,
            shiftSeconds: shiftDurationSeconds,
            rawSpeed: speedMph,
            tax: "$" + taxSaved.toFixed(2)
        };

        io.emit('telemetry_update', telemetryData);
        res.send('OK!');

    } catch (liveError) {
        console.error('Error handling live Torque packet:', liveError.message);
        res.send('OK!');
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
