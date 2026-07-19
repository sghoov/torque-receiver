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
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });
            return res.send('Success: Reset!');
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
            return res.send(`Updated!`);
        }
        return res.status(400).send('Error: No valid numeric parameters.');
    } catch (error) {
        console.error('Shortcut endpoint error:', error.message);
        res.status(500).send('Error handled safely.');
    }
});

app.get('/live', async (req, res) => {
    try {
        let incomingSpeed = parseFloat(Array.isArray(req.query.kff1001) ? req.query.kff1001[0] : req.query.kff1001) || 0;
        let incomingDistance = parseFloat(Array.isArray(req.query.kff1204) ? req.query.kff1204[0] : req.query.kff1204) || 0;   
        let incomingTemp = req.query.k46 ? parseFloat(Array.isArray(req.query.k46) ? req.query.k46[0] : req.query.k46) : null;
        let incomingAltitude = parseFloat(Array.isArray(req.query.kff1010) ? req.query.kff1010[0] : req.query.kff1010) || 0;
        let incomingBearing = req.query.kff123b ? parseFloat(Array.isArray(req.query.kff123b) ? req.query.kff123b[0] : req.query.kff123b) : null;
        let incomingHwyPercent = parseFloat(Array.isArray(req.query.kff1297) ? req.query.kff1297[0] : req.query.kff1297) || 0;
        let incomingTorque = parseFloat(Array.isArray(req.query.kff1225) ? req.query.kff1225[0] : req.query.kff1225) || 0;

        // PERSISTENCE LOGIC: Only update if Torque actually provides new GPS data
        let latIn = parseFloat(Array.isArray(req.query.kff1006) ? req.query.kff1006[0] : req.query.kff1006);
        let lonIn = parseFloat(Array.isArray(req.query.kff1005) ? req.query.kff1005[0] : req.query.kff1005);
        if (!isNaN(latIn) && latIn !== 0) currentLat = latIn;
        if (!isNaN(lonIn) && lonIn !== 0) currentLon = lonIn;

        let speedMph = incomingSpeed * 0.621371;
        if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
        
        let rawTripDistanceMiles = incomingDistance * 0.621371;
        if (rawTripDistanceMiles < 0) rawTripDistanceMiles = 0;
        let taxSaved = rawTripDistanceMiles * MILEAGE_RATE;

        let styleMultiplier = 1.0 + ((incomingHwyPercent / 100) * 0.18);
        let baseWeightedMiles = rawTripDistanceMiles * styleMultiplier;

        if (speedMph > 2) {
            if (lastKnownAltitudeMeters !== null) {
                let deltaFeet = (incomingAltitude - lastKnownAltitudeMeters) * 3.28084;
                if (deltaFeet > 3.0) accumulatedTerrainAdjustmentMiles += (deltaFeet * 0.005);
            }
            lastKnownAltitudeMeters = incomingAltitude;
            if (incomingTorque <= 0) accumulatedTerrainAdjustmentMiles -= ((speedMph / 3600) * 0.45);
        } else {
            lastKnownAltitudeMeters = incomingAltitude;
        }

        let adjustedTripDistanceMiles = Math.max(0, baseWeightedMiles + accumulatedTerrainAdjustmentMiles);
        let tempFahrenheit = incomingTemp !== null ? (Math.round((incomingTemp * 9/5) + 32) + 1) + "°F" : "--°F";
        let compassHeading = (incomingBearing !== null && !isNaN(incomingBearing)) ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((incomingBearing % 360) / 45)) % 8] : "--";

        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", 
            speed: Math.round(speedMph) + " mph",
            temperature: tempFahrenheit,
            compass: compassHeading,
            lat: currentLat, // Always sends the last known good coordinate
            lon: currentLon  // Always sends the last known good coordinate
        };

        io.emit('telemetry_update', telemetryData);
        res.send('OK!');
    } catch (liveError) {
        console.error('Error:', liveError.message);
        res.send('OK!');
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
