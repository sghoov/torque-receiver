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
    // 1. EXTRACTION ZONE: Pull parameters safely from direct keys or index-0 arrays
    let incomingSpeed = req.query.v || 0;
    if (Array.isArray(incomingSpeed)) incomingSpeed = incomingSpeed[0];
    let rawSpeedMs = parseFloat(incomingSpeed) || 0;

    let incomingDistance = req.query.kff1204 || 0;
    if (Array.isArray(incomingDistance)) incomingDistance = incomingDistance[0];
    let rawDistanceKm = parseFloat(incomingDistance) || 0;   

    let incomingTemp = req.query.k46 || null;
    if (Array.isArray(incomingTemp)) incomingTemp = incomingTemp[0];
    let rawAmbientCelsius = incomingTemp ? parseFloat(incomingTemp) : null; 

    let incomingAltitude = req.query.kff1238 || req.query.kff122b || 0;
    if (Array.isArray(incomingAltitude)) incomingAltitude = incomingAltitude[0];
    let rawAltitudeMeters = parseFloat(incomingAltitude) || 0; 

    // 2. TRUE ACCURATE CONVERSIONS
    // 'v' is sent by Torque as Meters per Second. Converting directly to MPH (m/s * 2.23694)
    let speedMph = rawSpeedMs * 2.23694;
    
    // Noise floor protection floor filter
    if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temperature cleanly to Fahrenheit with the custom display offset
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // Convert Altitude to feet
    let elevationDisplay = "-- ft";
    if (rawAltitudeMeters !== 0) {
        elevationDisplay = Math.round(rawAltitudeMeters * 3.28084) + " ft";
    }

    // 3. PACKAGE CLEAN PRE-SCALED PAYLOAD
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: elevationDisplay, 
        temperature: tempFahrenheit,
        tripMilesRaw: tripDistance,
        rawSpeed: speedMph,
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. EMIT DIRECTLY TO WIDGET
    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
