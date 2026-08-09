const express = require('express');
const app = express();
const http = require('http').createServer(app);
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

// BASELINE SNAPSHOT FOR RANGE RESET
let rangeDistanceBaseline = 0.0; 
let latestRawDistanceMiles = 0.0;

// TORQUE AUTO-RESET GUARD STATE
let savedPreviousTripsMiles = 0.0;
let lastKnownRawMiles = 0.0;

// STICKY GPS STORAGE: Default to Pacifica
let currentLat = 37.6017; 
let currentLon = -122.4868;

app.get('/', (req, res) => {
    res.send('Telemetry physics engine server is up and running safely!');
});

app.get('/current-city', (req, res) => {
    res.json({ lat: currentLat, lon: currentLon });
});

app.get('/update-range', (req, res) => {
    try {
        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            savedPreviousTripsMiles = 0.0;
            lastKnownRawMiles = 0.0;
            
            // Lock in current raw miles as the baseline for range calculations
            rangeDistanceBaseline = latestRawDistanceMiles;

            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Range Reset] Full server reset completed! Baseline: ${rangeDistanceBaseline.toFixed(2)} mi`);
            return res.send(`Success: Full range and session miles reset to 0.0!`);
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
        // Lowercase all incoming URL query keys to make Torque parameter keys case-insensitive
        const params = {};
        for (let key in req.query) {
            params[key.toLowerCase()] = req.query[key];
        }

        let incomingSpeed = params['kff1001'] || 0;
        if (Array.isArray(incomingSpeed)) incomingSpeed = incomingSpeed[0];
        let rawSpeedKmh = parseFloat(incomingSpeed) || 0;

        let incomingDistance = params['kff1204'] || 0;
        if (Array.isArray(incomingDistance)) incomingDistance = incomingDistance[0];
        let rawDistanceKm = parseFloat(incomingDistance) || 0;   

        // Safe Temperature Parsing
        let incomingTemp = params['k46'] || null;
        if (Array.isArray(incomingTemp)) incomingTemp = incomingTemp[0];
        
        let rawAmbientCelsius = null;
        if (incomingTemp !== null && incomingTemp !== "" && !isNaN(parseFloat(incomingTemp))) {
            rawAmbientCelsius = parseFloat(incomingTemp);
        }

        let incomingAltitude = params['kff1010'] || 0;
        if (Array.isArray(incomingAltitude)) incomingAltitude = incomingAltitude[0];
        let rawAltitudeMeters = parseFloat(incomingAltitude) || 0; 

        let incomingBearing = params['kff123b'] || null;
        if (Array.isArray(incomingBearing)) incomingBearing = incomingBearing[0];
        let rawBearing = (incomingBearing !== null && !isNaN(parseFloat(incomingBearing))) ? parseFloat(incomingBearing) : null;

        let incomingHwyPercent = params['kff1297'] || 0;
        if (Array.isArray(incomingHwyPercent)) incomingHwyPercent = incomingHwyPercent[0];
        let hwyPercent = parseFloat(incomingHwyPercent) || 0;

        let incomingTorque = params['kff1225'] || 0;
        if (Array.isArray(incomingTorque)) incomingTorque = incomingTorque[0];
        let motorTorque = parseFloat(incomingTorque) || 0;

        // PERSISTENCE FIX
        let incomingLat = params['kff1006'] || null;
        if (Array.isArray(incomingLat)) incomingLat = incomingLat[0];
        let latIn = parseFloat(incomingLat);
        if (!isNaN(latIn) && latIn !== 0) currentLat = latIn;

        let incomingLon = params['kff1005'] || null;
        if (Array.isArray(incomingLon)) incomingLon = incomingLon[0];
        let lonIn = parseFloat(incomingLon);
        if (!isNaN(lonIn) && lonIn !== 0) currentLon = lonIn;

        let speedMph = rawSpeedKmh * 0.621371;
        if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
        
        let rawTripDistanceMiles = rawDistanceKm * 0.621371;
        if (rawTripDistanceMiles < 0) rawTripDistanceMiles = 0;

        // --- 1. GPS / OBD SPIKE FILTER ---
        if (lastKnownRawMiles > 0 && rawTripDistanceMiles > (lastKnownRawMiles + 0.5)) {
            console.warn(`[Glitch Blocked] Ignored sudden jump from ${lastKnownRawMiles.toFixed(1)} to ${rawTripDistanceMiles.toFixed(1)} mi`);
            rawTripDistanceMiles = lastKnownRawMiles;
        }

        // --- 2. PROTECTED TORQUE AUTO-RESET GUARD ---
        if (rawTripDistanceMiles > 0 && lastKnownRawMiles > 0) {
            if (rawTripDistanceMiles < (lastKnownRawMiles - 0.5)) {
                if (lastKnownRawMiles < 150.0) {
                    savedPreviousTripsMiles += lastKnownRawMiles;
                    console.log(`[Torque Auto-Reset] True reset detected! Saved ${lastKnownRawMiles.toFixed(2)} mi.`);
                } else {
                    console.warn(`[Torque Auto-Reset] Ignored reset from glitched baseline: ${lastKnownRawMiles.toFixed(2)} mi.`);
                }
                rangeDistanceBaseline = 0.0; 
            }
        }

        if (rawTripDistanceMiles > 0) {
            lastKnownRawMiles = rawTripDistanceMiles;
        }

        // Cumulative Stream Miles (Unweighted True Odometer)
        let trueSessionMiles = savedPreviousTripsMiles + (rawTripDistanceMiles > 0 ? rawTripDistanceMiles : lastKnownRawMiles);

        // Store latest raw miles snapshot
        latestRawDistanceMiles = rawTripDistanceMiles;

        // Distance driven on current charge
        let milesOnCurrentCharge = Math.max(0, rawTripDistanceMiles - rangeDistanceBaseline);
        let taxSaved = trueSessionMiles * MILEAGE_RATE;

        // --- CALIBRATED RANGE MULTIPLIERS ---
        let speedPenalty = 0.0;
        if (speedMph > 53) {
            speedPenalty = Math.min(0.18, ((speedMph - 53) / 17) * 0.18); 
        }
        let hwyPenalty = (hwyPercent / 100) * 0.10; 
        let styleMultiplier = 1.0 + speedPenalty + hwyPenalty;

        let baseWeightedMiles = (milesOnCurrentCharge * styleMultiplier) * 1.05;

        if (speedMph > 2) {
            if (lastKnownAltitudeMeters !== null) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;
                if (deltaFeet > 2.0) { 
                    let climbWeight = deltaFeet * 0.006; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            if (motorTorque <= 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.25; 
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        } else {
            lastKnownAltitudeMeters = rawAltitudeMeters;
        }

        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; 

        let tempFahrenheit = "--°F";
        if (rawAmbientCelsius !== null) {
            tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
        }

        let elevationDisplay = "-- ft";
        if (params['kff1010']) {
            let trueFeet = (rawAltitudeMeters * 3.28084) + 104; 
            elevationDisplay = Math.round(trueFeet) + " ft";
        }

        let compassHeading = "--";
        if (rawBearing !== null && !isNaN(rawBearing)) {
            const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            let index = Math.round(((rawBearing % 360) / 45)) % 8;
            compassHeading = directions[index];
        }

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
