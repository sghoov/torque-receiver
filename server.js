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
let accumulatedTerrainAdjustmentMiles = 0.0; // Tracks the running total of regen credits & climb penalties

app.get('/', (req, res) => {
    res.send('Telemetry physics engine server is up and running safely!');
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

        // NEW PIDs FOR HIGHWAY PERCENT & MOTOR TORQUE
        let incomingHwyPercent = req.query.kff1297 || 0;
        if (Array.isArray(incomingHwyPercent)) incomingHwyPercent = incomingHwyPercent[0];
        let hwyPercent = parseFloat(incomingHwyPercent) || 0;

        let incomingTorque = req.query.kff1225 || 0;
        if (Array.isArray(incomingTorque)) incomingTorque = incomingTorque[0];
        let motorTorque = parseFloat(incomingTorque) || 0;

        // 2. STANDARD CONVERSIONS
        let speedMph = rawSpeedKmh * 0.621371;
        if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
        
        let rawTripDistanceMiles = rawDistanceKm * 0.621371;
        if (rawTripDistanceMiles < 0) rawTripDistanceMiles = 0;
        
        let taxSaved = rawTripDistanceMiles * MILEAGE_RATE;

        // 3. ADVANCED DRIVING PHYSICS POOL
        // A. Running Style Base Multiply (0% Penalty on City, Max 22% Penalty on Highway)
        let styleMultiplier = 1.0 + ((hwyPercent / 100) * 0.22);
        let baseWeightedMiles = rawTripDistanceMiles * styleMultiplier;

        // B. Real-time Terrain Incline & Regen Math (Processed when moving)
        if (speedMph > 2) {
            // Altitude Delta Tracking
            if (lastKnownAltitudeMeters !== null) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;

                if (deltaFeet > 0.5) { 
                    // CLIMB PENALTY: Going up an incline burns extra battery capacity
                    let climbWeight = deltaFeet * 0.005; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            // RECUPERATIVE BRAKING LOGIC
            // If vehicle is moving but motor torque reads flat 0, car is in active regen mode
            if (motorTorque === 0) {
                // Approximate energy recovery calculation (~60% efficiency credit per second)
                let regenCreditPerSecond = (speedMph / 3600) * 0.60;
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        } else {
            // Reset altitude tracking anchor point if vehicle completely stops
            lastKnownAltitudeMeters = rawAltitudeMeters;
        }

        // C. Combine Everything into a Final Dynamic Range Adjustment
        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; // Prevent reverse loops

        // 4. DISPLAY FORMAT CALCULATIONS
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

        // 5. BEAM PAYLOAD TO WIDGET SCRIPT
        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", // Scales range down or up dynamically
            speed: Math.round(speedMph) + " mph",
            elevation: elevationDisplay, 
            temperature: tempFahrenheit,
            compass: compassHeading,
            tripMilesRaw: adjustedTripDistanceMiles, // Feeds your left-side battery slider calculation
            actualSessionMilesRaw: rawTripDistanceMiles, // Feeds your pure "Trip Miles" container box
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
