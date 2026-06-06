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
    // 1. Extract parameters 
    let rawSpeedMs = parseFloat(req.query.kff120c) || 0;       // Torque GPS speed arrives in meters/second
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let tripDistance = parseFloat(req.query.kff1204) || 0;   

    // 2. Perform conversions & calculations
    let speedMph = rawSpeedMs * 2.23694; // Perfect conversion from m/s to MPH
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Dynamic efficiency handling
    let dynamicEfficiency = 4.2; 
    if (speedMph > 65) dynamicEfficiency = 3.4; 
    if (speedMph === 0) dynamicEfficiency = 0.0;

    // 3. Package calculations (We pass numeric metrics so StreamElements can optionally scale them)
    const telemetryData = {
        distance: tripDistance.toFixed(1) + " mi",
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: dynamicEfficiency.toFixed(1) + " mi/kWh", 
        tripMilesRaw: tripDistance,
        tax: "$" + taxSaved.toFixed(2)
    };

    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
