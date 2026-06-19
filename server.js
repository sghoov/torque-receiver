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

let shortcutStartMiles = null;
let shortcutMaxRange = null;

app.get('/', (req, res) => {
    res.send('Telemetry server is up and running safely!');
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

app.get('/live', (req, res) => {
    try {
        // 1. SAFE ARRAY EXTRACTION
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

        let incomingBearing = req.query.kff122b || null;
        if (Array.isArray(incomingBearing)) incomingBearing = incomingBearing[0];
        let rawBearing = incomingBearing !== null ? parseFloat(incomingBearing) : null;

        // 2. CONVERSION MATH
        let speedMph = rawSpeedKmh * 0.621371;
        if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
        
        let rawTripDistanceMiles = rawDistanceKm * 0.621371;
        if (rawTripDistanceMiles < 0) rawTripDistanceMiles = 0;
        
        let taxSaved = rawTripDistanceMiles * MILEAGE_RATE;

        // 🚀 HIGHWAY DRAIN MULTIPLIER LOGIC
        // City driving (under 50 mph) stays at 1.0x multiplier.
        // Freeway speeds (50-75+ mph) ramp up progressively from 1.0x to 1.35x extra drain.
        let drainMultiplier = 1.0;
        if (speedMph > 50) {
            let speedFactor = (speedMph - 50) / 25; // Ramps from 0 to 1 between 50mph and 75mph
            drainMultiplier = 1.0 + (speedFactor * 0.35); // Caps around 1.35x multiplier
            if (drainMultiplier > 1.4) drainMultiplier = 1.4; // Safety ceiling limit
        }

        // Apply the dynamic highway penalty to the tracker calculations
        let adjustedTripDistanceMiles = rawTripDistanceMiles * drainMultiplier;

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

        // 3. PACKAGE DYNAMIC PAYLOAD WITH SEPARATED ACTUAL & DRAIN MILEAGE
        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", // Adjusted miles drives range number down aggressively
            speed: Math.round(speedMph) + " mph",
            elevation: elevationDisplay, 
            temperature: tempFahrenheit,
            compass: compassHeading,
            tripMilesRaw: adjustedTripDistanceMiles, // Feeds range slider calculation
            actualSessionMilesRaw: rawTripDistanceMiles, // Feeds pure "Trip Miles" display box
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
