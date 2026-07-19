const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const MILEAGE_RATE = 0.725; 

// PERSISTENT SERVER STATE STORAGE
let shortcutStartMiles = null;
let shortcutMaxRange = null;
let lastKnownAltitudeMeters = null;
let accumulatedTerrainAdjustmentMiles = 0.0; 

// STICKY GPS STORAGE (Default: Pacifica)
let currentLat = 37.6017; 
let currentLon = -122.4868;

app.get('/', (req, res) => res.send('Telemetry engine active.'));

app.get('/current-city', (req, res) => res.json({ lat: currentLat, lon: currentLon }));

app.get('/update-range', (req, res) => {
    try {
        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
        }
        let parsedStart = parseFloat(req.query.startMiles);
        let parsedRange = parseFloat(req.query.maxRange);
        if (!isNaN(parsedStart)) shortcutStartMiles = parsedStart;
        if (!isNaN(parsedRange)) shortcutMaxRange = parsedRange;

        io.emit('manual_range_update', {
            startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
            maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
        });
        res.send(`Updated!`);
    } catch (error) { res.status(500).send('Error.'); }
});

app.get('/live', async (req, res) => {
    try {
        // PARSE INPUTS
        const getVal = (q) => parseFloat(Array.isArray(q) ? q[0] : q) || 0;
        let speedKmh = getVal(req.query.kff1001);
        let distKm = getVal(req.query.kff1204);
        let tempC = req.query.k46 ? getVal(req.query.k46) : null;
        let altMeters = getVal(req.query.kff1010);
        let bearing = getVal(req.query.kff123b);
        let hwyPct = getVal(req.query.kff1297);
        let torque = getVal(req.query.kff1225);

        // PERSISTENCE LOGIC
        let latIn = parseFloat(Array.isArray(req.query.kff1006) ? req.query.kff1006[0] : req.query.kff1006);
        let lonIn = parseFloat(Array.isArray(req.query.kff1005) ? req.query.kff1005[0] : req.query.kff1005);
        if (!isNaN(latIn) && latIn !== 0) currentLat = latIn;
        if (!isNaN(lonIn) && lonIn !== 0) currentLon = lonIn;

        // PHYSICS CALCULATIONS
        let speedMph = (speedKmh * 0.621371 < 0.8) ? 0 : speedKmh * 0.621371;
        let rawDistMiles = Math.max(0, distKm * 0.621371);
        
        // Elevation/Terrain Math
        if (speedMph > 2) {
            if (lastKnownAltitudeMeters !== null) {
                let deltaFeet = (altMeters - lastKnownAltitudeMeters) * 3.28084;
                if (deltaFeet > 3.0) accumulatedTerrainAdjustmentMiles += (deltaFeet * 0.005);
            }
            lastKnownAltitudeMeters = altMeters;
            if (torque <= 0) accumulatedTerrainAdjustmentMiles -= ((speedMph / 3600) * 0.45);
        } else {
            lastKnownAltitudeMeters = altMeters;
        }

        let adjustedDist = Math.max(0, (rawDistMiles * (1.0 + ((hwyPct / 100) * 0.18))) + accumulatedTerrainAdjustmentMiles);

        // FORMATTING
        let tempF = tempC !== null ? Math.round((tempC * 9/5) + 32) + 1 + "°F" : "--°F";
        let elevFt = Math.round((altMeters * 3.28084) + 104) + " ft";
        let compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((bearing % 360) / 45) % 8] || "--";

        const telemetryData = {
            distance: adjustedDist.toFixed(1) + " mi",
            speed: Math.round(speedMph) + " mph",
            elevation: elevFt,
            temperature: tempF,
            compass: compass,
            tax: "$" + (rawDistMiles * MILEAGE_RATE).toFixed(2),
            lat: currentLat,
            lon: currentLon
        };

        io.emit('telemetry_update', telemetryData);
        res.send('OK!');
    } catch (liveError) {
        console.error('Error:', liveError.message);
        res.send('OK!');
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server listening on ${PORT}`));
