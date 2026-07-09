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

// GEOCODING CACHE TO PREVENT API OVERUSE (STAYS STICKY)
let currentCityDisplay = "PACIFICA"; // Initial default fallback
let lastGeocodeTime = 0;
let lastLat = null;
let lastLon = null;

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
        let baseWeightedMiles =
