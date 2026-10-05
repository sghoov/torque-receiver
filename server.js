const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Enable large JSON body parsing (10MB for direct screenshot uploads from iOS Shortcut)
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

// Helper to call Google Gemini API with valid active fallback models
async function callGeminiVision(apiKey, base64Data, mimeType) {
  // Verified active model endpoints
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro'];
  const promptText = 'Extract the offer payout price (as a number) and total miles (as a number) from this screenshot. Return strictly valid raw JSON without markdown formatting in this exact shape: {"price": 15.20, "miles": 6.2}';

  for (const model of models) {
    try {
      console.log(`Attempting Vision extraction with model: ${model}...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType, data: base64Data } },
              { text: promptText }
            ]
          }]
        })
      });

      if (response.ok) {
        const resData = await response.json();
        const responseText = resData.candidates[0].content.parts[0].text;
        const cleanJson = responseText.replace(/```json\s*|```/g, '').trim();
        return JSON.parse(cleanJson);
      } else {
        const errText = await response.text();
        console.warn(`Model ${model} returned status ${response.status}: ${errText}. Trying fallback...`);
      }
    } catch (e) {
      console.warn(`Error on model ${model}:`, e.message);
    }
  }

  throw new Error('All configured Gemini vision models failed or were overloaded.');
}

// Helper to upload output files to Dropbox
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
// AI VISION OFFER CARD PROCESSOR
// ==========================================
async function processOfferCard(optionalBase64Image = null) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const dbxToken = process.env.DROPBOX_ACCESS_TOKEN;

    if (!apiKey) throw new Error('GEMINI_API_KEY missing on Render');
    if (!dbxToken) throw new Error('DROPBOX_ACCESS_TOKEN missing on Render');

    let base64Data = optionalBase64Image;
    let mimeType = 'image/png';

    // If no direct image payload provided, fallback to downloading from Dropbox
    if (!base64Data) {
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
        throw new Error(`Dropbox Download Error [${dbxDownloadRes.status}]: ${errText}`);
      }

      const arrayBuffer = await dbxDownloadRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      base64Data = buffer.toString('base64');

      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        mimeType = 'image/jpeg';
      }
    } else {
      // Clean data URI prefix if sent directly from Shortcut/web
      base64Data = base64Data.replace(/^data:image\/\w+;base64,/, '');
    }

    // Process image with auto-failover models
    const data = await callGeminiVision(apiKey, base64Data, mimeType);

    // Read current total from Dropbox
    let currentTotal = 0;
    try {
      const totalRes = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dbxToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path: '/total.txt' })
        }
      });
      if (totalRes.ok) {
        const totalText = await totalRes.text();
        currentTotal = parseFloat(totalText) || 0;
      }
    } catch (e) {}

    const newTotal = (currentTotal + parseFloat(data.price)).toFixed(2);

    // Save outputs back to Dropbox for stream overlays
    await uploadToDropbox(dbxToken, '/total.txt', newTotal.toString());
    await uploadToDropbox(dbxToken, '/offer_miles.txt', data.miles.toString());

    return { success: true, price: data.price, miles: data.miles, total: newTotal };
  } catch (err) {
    console.error('Error in processOfferCard:', err.message);
    throw err;
  }
}

// ==========================================
// ROUTES
// ==========================================

app.get('/', (req, res) => {
    res.send('Telemetry physics engine & AI Vision server is up and running safely!');
});

// Route to trigger AI processing (supports optional direct image payload or Dropbox pull)
app.post('/process-card', async (req, res) => {
  try {
    const directImage = req.body && req.body.image ? req.body.image : null;
    const result = await processOfferCard(directImage);
    res.json({ status: 'success', data: result });
  } catch (error) {
    console.error('API /process-card failed:', error.message);
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
