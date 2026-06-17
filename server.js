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
    // 1. SAFE ARRAY EXTRACTION: Target kff1001 directly
    let incomingSpeed = req.query.kff1001 || 0;
    
    // If Torque sends it inside brackets [x, y], extract the first live index element
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

    // 2. CONVERSION MATH (kff1001 sends speed in Kilometers per Hour)
    let speedMph = rawSpeedKmh * 0.621371;
    
    // Clean noise floor clamp
    if (speedMph < 0.8 || speedMph > 110) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temperature cleanly to Fahrenheit with a +1 dashboard calibration offset
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // Convert Altitude precisely to feet and apply a +51ft local geoid calibration offset
    let elevationDisplay = "-- ft";
    if (rawAltitudeMeters !== 0) {
        let trueFeet = (rawAltitudeMeters * 3.28084) + 51;
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
