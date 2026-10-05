const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Dropbox SDK Import
const { Dropbox } = require('dropbox');

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

    const dbx = new Dropbox({ accessToken: dbxToken });
    console.log('Fetching /offercard.png from Dropbox...');
    
    // Download image from Dropbox
    const dbxResponse = await dbx.filesDownload({ path: '/offercard.png' });
    const fileBinary = dbxResponse.result.fileBinary;
    const buffer = Buffer.isBuffer(fileBinary) ? fileBinary : Buffer.from(fileBinary);
    const base64Data = buffer.toString('base64');

    let mimeType = 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      mimeType = 'image/jpeg';
    }

    console.log('Sending image to Gemini via REST...');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: mimeType, data: base64Data } },
            { text: `Extract offer payout price and total miles in raw JSON format: {"price": 15.20, "miles": 6.2}` }
          ]
        }]
      })
    });

    const resData = await response.json();

    if (!response.ok) {
      console.error('GOOGLE_RAW_ERROR:', JSON.stringify(resData));
      throw new Error(`Google Error [${response.status}]: ${resData.error?.message || 'Bad Request'}`);
    }

    const responseText = resData.candidates[0].content.parts[0].text;
    const cleanJson = responseText.replaceAll('```json', '').replaceAll('```', '').trim();
    const data = JSON.parse(cleanJson);

    // Save outputs back to Dropbox
    let currentTotal = 0;
    try {
      const totalFile = await dbx.filesDownload({ path: '/total.txt' });
      const totalBuf = Buffer.isBuffer(totalFile.result.fileBinary) ? totalFile.result.fileBinary : Buffer.from(totalFile.result.fileBinary);
      currentTotal = parseFloat(totalBuf.toString('utf-8')) || 0;
    } catch (e) {}

    const newTotal = (currentTotal + parseFloat(data.price)).toFixed(2);

    await dbx.filesUpload({ path: '/total.txt', contents: newTotal, mode: { '.tag': 'overwrite' } });
    await dbx.filesUpload({ path: '/offer_miles.txt', contents: data.miles.toString(), mode: { '.tag': 'overwrite' } });

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

// Route to trigger AI processing of offercard.png
app.post('/process-card', async (req, res) => {
  try {
    const result = await processOfferCard();
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
        // 1. FULL SHIFT RESET (New Day / New Stream)
        if (req.query.fullReset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            savedPreviousTripsMiles = 0.0;
            lastKnownRawMiles = 0.0;
            shiftStartTime = null; // Resets shift timer back to 0:00
            rangeDistanceBaseline = latestRawDistanceMiles;
            sessionMilesBaseline = latestRawDistanceMiles;

            io.emit('shift_reset');
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Shift Reset] Full stream shift clock, miles, and range reset executed.`);
            return res.send(`Success: Full shift clock, session miles, and range reset to 0!`);
        }

        // 2. MID-STREAM CHARGE RESET (Resets battery bar ONLY, keeps shift timer & odometer running)
        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            
            // Baseline snapshot for current charge
            rangeDistanceBaseline = latestRawDistanceMiles;

            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Battery Charge Reset] Range baseline set to: ${rangeDistanceBaseline.toFixed(2)} mi`);
            return res.send(`Success: Range bar reset to 70mi! (Shift time & total miles kept intact)`);
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
        // Safe Parameter Parsing Helper (returns null if key is missing/invalid)
        const getParam = (key) => {
            let val = req.query[key] || req.query[key.toUpperCase()] || req.query[key.toLowerCase()];
            if (Array.isArray(val)) val = val[0];
            if (val === undefined || val === null || val === "" || isNaN(parseFloat(val))) return null;
            return parseFloat(val);
        };

        let rawSpeedKmh = getParam('kff1001') || 0;
        let speedMph = rawSpeedKmh * 0.621371;
        if (isNaN(speedMph) || speedMph < 0.8 || speedMph > 110) speedMph = 0;

        // --- SERVER-SIDE SHIFT TIMER TRIGGER ---
        if (speedMph > 1.0 && shiftStartTime === null) {
            shiftStartTime = Date.now();
            console.log(`[Shift Timer] Started shift timer at ${new Date(shiftStartTime).toLocaleTimeString()}`);
        }

        let shiftDurationSeconds = shiftStartTime ? Math.floor((Date.now() - shiftStartTime) / 1000) : 0;

        // --- DISTANCE HANDLING ---
        let incomingDistanceKm = getParam('kff1204');
        let rawTripDistanceMiles = lastKnownRawMiles; // Default to last known value if PID is missing

        if (incomingDistanceKm !== null) {
            let parsedMiles = incomingDistanceKm * 0.621371;
            
            // Ignore corrupted zero or near-zero drops from Bluetooth OBD disconnects
            if (!isNaN(parsedMiles) && parsedMiles > 0.01) {
                
                // 1. GPS Tunnel / Teleport Spike Filter (> 5.0 miles in a single tick)
                if (lastKnownRawMiles > 0 && parsedMiles > (lastKnownRawMiles + 5.0)) {
                    console.warn(`[Glitch Blocked] Ignored sudden jump from ${lastKnownRawMiles.toFixed(1)} to ${parsedMiles.toFixed(1)} mi`);
                    rawTripDistanceMiles = lastKnownRawMiles;
                } 
                // 2. TRUE TORQUE APP RESET GUARD: Only save baseline if reading drops close to zero (< 0.5 mi)
                else if (lastKnownRawMiles > 1.0 && parsedMiles < 0.5) {
                    savedPreviousTripsMiles += Math.max(0, lastKnownRawMiles - sessionMilesBaseline);
                    sessionMilesBaseline = 0.0;
                    rangeDistanceBaseline = 0.0;
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                    console.log(`[Torque Auto-Reset] Valid reset confirmed at ${parsedMiles.toFixed(2)} mi.`);
                } 
                // 3. NORMAL ODOMETER ADVANCEMENT
                else if (parsedMiles >= lastKnownRawMiles) {
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                }
                // Dips below lastKnownRawMiles that are not near zero are ignored (held at lastKnownRawMiles)
            }
        }

        latestRawDistanceMiles = rawTripDistanceMiles;

        // Stream Session Odometer
        let currentUnweightedMiles = Math.max(0, rawTripDistanceMiles - sessionMilesBaseline);
        let trueSessionMiles = savedPreviousTripsMiles + currentUnweightedMiles;
        if (isNaN(trueSessionMiles)) trueSessionMiles = 0.0;

        // Distance on Current Battery Charge
        let milesOnCurrentCharge = Math.max(0, rawTripDistanceMiles - rangeDistanceBaseline);
        let taxSaved = trueSessionMiles * MILEAGE_RATE;

        // --- CALIBRATED RANGE MULTIPLIERS ---
        let hwyPercent = getParam('kff1297') || 0;
        let motorTorque = getParam('kff1225') || 0;

        let speedPenalty = 0.0;
        if (speedMph > 53) {
            speedPenalty = Math.min(0.18, ((speedMph - 53) / 17) * 0.18); 
        }
        let hwyPenalty = (hwyPercent / 100) * 0.10; 
        let styleMultiplier = 1.0 + speedPenalty + hwyPenalty;

        let baseWeightedMiles = (milesOnCurrentCharge * styleMultiplier) * 1.05;

        // --- ALTITUDE & HILL CLIMB CALCULATIONS ---
        let rawAltitudeMeters = getParam('kff1010');
        
        // ONLY calculate hill climb if PID kff1010 was explicitly provided in this packet
        if (speedMph > 2 && rawAltitudeMeters !== null) {
            if (lastKnownAltitudeMeters !== null && !isNaN(lastKnownAltitudeMeters)) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;
                
                // Real climbs between 3 ft and 120 ft per frame
                if (deltaFeet > 3.0 && deltaFeet < 120.0) { 
                    let climbWeight = deltaFeet * 0.005; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters; // Update altitude baseline

            if (motorTorque <= 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.20; 
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        }

        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (isNaN(adjustedTripDistanceMiles) || adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; 

        // --- OTHER SENSOR PARSING ---
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
            tripMilesRaw: adjustedTripDistanceMiles,           // Drives Range Slider
            actualSessionMilesRaw: trueSessionMiles,            // Drives Stream Odometer
            shiftSeconds: shiftDurationSeconds,                 // Drives Stream Timer
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
