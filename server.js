const express = require('express');
const app = express();
const http = require('http').createServer(app);
const https = require('https'); // Native module fallback for requests
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const MILEAGE_RATE = 0.725; // 2026 IRS Rate

// PERSISTENT SERVER STATE STORAGE
let shortcutStartMiles = null;
let shortcutMaxRange = null;

let lastKnownAltitudeMeters = null;
let accumulatedTerrainAdjustmentMiles = 0.0; 

// GEOCODING CACHE TO PREVENT API OVERUSE (STAYS STICKY)
let currentCityDisplay = "PACIFICA"; 
let lastGeocodeTime = 0;
let lastLat = null;
let lastLon = null;

// Lightweight HTTP client fallback wrapper to avoid native fetch version crashes
function safeFetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => reject(err));
    });
}

app.get('/', (req, res) => {
    res.send('Telemetry physics engine server is up and running safely!');
});

// Let the widget poll the last known city instantly on load
app.get('/current-city', (req, res) => {
    res.json({ city: currentCityDisplay });
});

app.get('/update-range', (req, res) => {
    try {
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
        // 1. SAFE ARRAY PARAMETER EXTRACTION
        let incomingSpeed = req.query.kff1001 || 0;
        if (Array.isArray(incomingSpeed)) incomingSpeed = incomingSpeed[0];
        let rawSpeedKmh = parseFloat(incomingSpeed) || 0;

        let incomingDistance = req.query.kff1204 || 0;
        if (Array.isArray(incomingDistance)) incomingDistance = incomingDistance[0];
        let rawDistanceKm = parseFloat(incomingDistance) || 0;   

        let incomingTemp = req.query.k46 || null;
        if (Array.isArray(incomingTemp)) incomingTemp = incomingTemp[0];
        let rawAmbientCelsius = incomingTemp ? parseFloat(incomingTemp) : null; 

        let incomingAltitude = req.query.kff1010 || 0;
        if (Array.isArray(incomingAltitude)) incomingAltitude = incomingAltitude[0];
        let rawAltitudeMeters = parseFloat(incomingAltitude) || 0; 

        let incomingBearing = req.query.kff123b || null;
        if (Array.isArray(incomingBearing)) incomingBearing = incomingBearing[0];
        let rawBearing = incomingBearing !== null ? parseFloat(incomingBearing) : null;

        let incomingHwyPercent = req.query.kff1297 || 0;
        if (Array.isArray(incomingHwyPercent)) incomingHwyPercent = incomingHwyPercent[0];
        let hwyPercent = parseFloat(incomingHwyPercent) || 0;

        let incomingTorque = req.query.kff1225 || 0;
        if (Array.isArray(incomingTorque)) incomingTorque = incomingTorque[0];
        let motorTorque = parseFloat(incomingTorque) || 0;

        // GPS Coordinates from Torque Pro
        let incomingLat = req.query.kff1006 || null;
        if (Array.isArray(incomingLat)) incomingLat = incomingLat[0];
        let rawLat = incomingLat ? parseFloat(incomingLat) : null;

        let incomingLon = req.query.kff1005 || null;
        if (Array.isArray(incomingLon)) incomingLon = incomingLon[0];
        let rawLon = incomingLon ? parseFloat(incomingLon) : null;

        // 2. STANDARD CONVERSIONS
        let speedMph = rawSpeedKmh * 0.621371;
        if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
        
        let rawTripDistanceMiles = rawDistanceKm * 0.621371;
        if (rawTripDistanceMiles < 0) rawTripDistanceMiles = 0;
        
        let taxSaved = rawTripDistanceMiles * MILEAGE_RATE;

        // 3. PERFECTED DRIVING PHYSICS POOL
        let styleMultiplier = 1.0 + ((hwyPercent / 100) * 0.18);
        let baseWeightedMiles = rawTripDistanceMiles * styleMultiplier;

        // Real-time Terrain Incline & Regen Math
        if (speedMph > 2) {
            if (lastKnownAltitudeMeters !== null) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;

                if (deltaFeet > 3.0) { 
                    let climbWeight = deltaFeet * 0.004; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            // RECUPERATIVE BRAKING LOGIC
            if (motorTorque === 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.45;
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        } else {
            lastKnownAltitudeMeters = rawAltitudeMeters;
        }

        // Combine Into Final Value
        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; 

        // 4. REVERSE GEOCODING ENGINE USING STABLE HTTPS CLIENT FALLBACK
        const now = Date.now();
        if (rawLat && rawLon && (rawLat !== lastLat || rawLon !== lastLon) && (now - lastGeocodeTime > 10000)) {
            lastLat = rawLat;
            lastLon = rawLon;
            lastGeocodeTime = now;

            try {
                const geoData = await safeFetchJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${rawLat}&longitude=${rawLon}&localityLanguage=en`);
                if (geoData) {
                    const city = geoData.city || geoData.locality || "";
                    if (city) {
                        currentCityDisplay = city.toUpperCase(); 
                    }
                }
            } catch (geoErr) {
                console.error('Geocoding dynamic fetch error:', geoErr.message);
            }
        }

        // 5. DISPLAY FORMAT CALCULATIONS
        let tempFahrenheit = "--°F";
        if (rawAmbientCelsius !== null) {
            tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
        }

        let elevationDisplay = "-- ft";
        if (req.query.kff1010) {
            let trueFeet = (rawAltitudeMeters * 3.28084) + 104; 
            elevationDisplay = Math.round(trueFeet) + " ft";
        }

        let compassHeading = "--";
        if (rawBearing !== null && !isNaN(rawBearing)) {
            const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            let index = Math.round(((rawBearing % 360) / 45)) % 8;
            compassHeading = directions[index];
        }

        // 6. BEAM PAYLOAD TO WIDGET SCRIPT
        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", 
            speed: Math.round(speedMph) + " mph",
            elevation: elevationDisplay, 
            temperature: tempFahrenheit,
            compass: compassHeading,
            city: currentCityDisplay, 
            tripMilesRaw: adjustedTripDistanceMiles, 
            actualSessionMilesRaw: rawTripDistanceMiles, 
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
