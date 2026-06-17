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

app.get('/', (req, res) => {
    res.send('Telemetry server is up and running!');
});

app.get('/live', (req, res) => {
    // 1. CHOOSE THE ACTIVE LIVE PARAMETER (v) FIRST
    let incomingSpeed = req.query.v || req.query.k5 || 0;
    
    // Safety check if Torque passes an array layout group [x, y] instead of a single string
    if (Array.isArray(incomingSpeed)) {
        incomingSpeed = incomingSpeed[0];
    }
    
    let rawSpeedKmh = parseFloat(incomingSpeed) || 0;

    // Handle Distance parameter arrays safely
    let incomingDistance = req.query.kff1204 || 0;
    if (Array.isArray(incomingDistance)) incomingDistance = incomingDistance[0];
    let rawDistanceKm = parseFloat(incomingDistance) || 0;   

    // Handle Temperature parameter arrays safely
    let incomingTemp = req.query.k46 || null;
    if (Array.isArray(incomingTemp)) incomingTemp = incomingTemp[0];
    let rawAmbientCelsius = incomingTemp ? parseFloat(incomingTemp) : null; 

    // Handle Elevation parameter arrays safely
    let incomingAltitude = req.query.kff1238 || req.query.kff122b || 0;
    if (Array.isArray(incomingAltitude)) incomingAltitude = incomingAltitude[0];
    let rawAltitudeMeters = parseFloat(incomingAltitude) || 0; 

    // 2. SPEED CONVERSION MATH
    // Since 'v' is tracking beautifully, we scale it to match your responsive dashboard layout
    let speedMph = rawSpeedKmh * 0.621371;
    
    // If Torque is transmitting pre-converted MPH, adjust scaling to prevent under-reporting
    if (rawSpeedKmh > 0 && rawSpeedKmh < 120 && (req.query.v && !req.query.k5)) {
        speedMph = rawSpeedKmh; 
    }
    
    if (speedMph < 0.5 || speedMph > 110) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temp to Fahrenheit with calibration offset
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // Convert Elevation Display
    let elevationDisplay = "-- ft";
    if (rawAltitudeMeters !== 0) {
        elevationDisplay = Math.round(rawAltitudeMeters * 3.28084) + " ft";
    }

    // 3. Package clean data payload for the stream overlay banner
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: elevationDisplay, 
        temperature: tempFahrenheit,
        tripMilesRaw: tripDistance,
        rawSpeed: speedMph,
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. Pipe data instantly to StreamElements
    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
