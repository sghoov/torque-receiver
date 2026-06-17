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
    // 1. SAFE ARRAY EXTRACTION: Target kff1001 for speed
    let incomingSpeed = req.query.kff1001 || 0;
    if (Array.isArray(incomingSpeed)) incomingSpeed = incomingSpeed[0];
    let rawSpeedKmh = parseFloat(incomingSpeed) || 0;

    // Handle Distance parameter arrays safely
    let incomingDistance = req.query.kff1204 || 0;
    if (Array.isArray(incomingDistance)) incomingDistance = incomingDistance[0];
    let rawDistanceKm = parseFloat(incomingDistance) || 0;   

    // Handle Temperature parameter arrays safely
    let incomingTemp = req.query.k46 || null;
    if (Array.isArray(incomingTemp)) incomingTemp = incomingTemp[0];
    let rawAmbientCelsius = incomingTemp ? parseFloat(incomingTemp) : null; 

    // TARGET ACTIVE GPS ALTITUDE (ff1010)
    let incomingAltitude = req.query.kff1010 || 0;
    if (Array.isArray(incomingAltitude)) incomingAltitude = incomingAltitude[0];
    let rawAltitudeMeters = parseFloat(incomingAltitude) || 0; 

    // 2. CONVERSION MATH
    let speedMph = rawSpeedKmh * 0.621371;
    if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temperature cleanly to Fahrenheit
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // Convert Altitude precisely to feet and apply local Bay Area sea-level adjustment
    let elevationDisplay = "-- ft";
    if (req.query.kff1010) {
        // Convert raw meters to feet, then add the local calibration offset to match true sea level
        let trueFeet = (rawAltitudeMeters * 3.28084) + 104; 
        elevationDisplay = Math.round(trueFeet) + " ft";
    }

    // 3. PACKAGE DYNAMIC PAYLOAD FOR STREAMELEMENTS
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: elevationDisplay, 
        temperature: tempFahrenheit,
        tripMilesRaw: tripDistance,
        rawSpeed: speedMph,
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. BEAM IT STRAIGHT TO THE DASH WIDGET
    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
