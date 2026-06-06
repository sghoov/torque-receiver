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
    // 1. Pull the raw parameters from Torque Pro
    let obdSpeedKmh = parseFloat(req.query.k0d) || parseFloat(req.query.kff120c) || 0; // Prioritizes stable OBD Wheel Speed, falls back to GPS
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let rawDistanceMeters = parseFloat(req.query.kff1204) || 0;   

    // 2. Exact Metric-to-Imperial Math Corrections
    let speedMph = obdSpeedKmh * 0.621371; // Converts stable KM/H directly to perfect MPH
    
    // Convert raw distance structure cleanly (checks if Torque is sending raw meters vs scaled imperial miles)
    let tripDistance = rawDistanceMeters > 100 ? (rawDistanceMeters * 0.000621371) : rawDistanceMeters;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Dynamic efficiency engine based on real-time speed transitions
    let dynamicEfficiency = 4.2; 
    if (speedMph > 65) dynamicEfficiency = 3.4; 
    if (speedMph === 0) dynamicEfficiency = 0.0;

    // 3. Package completely clean, pre-scaled numbers for the stream overlay
    const telemetryData = {
        distance: tripDistance.toFixed(1) + " mi",
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: dynamicEfficiency.toFixed(1) + " mi/kWh", 
        tripMilesRaw: tripDistance,
        rawSpeed: speedMph,
        tax: "$" + taxSaved.toFixed(2)
    };

    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
