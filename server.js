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
    // 1. Pull the raw parameters from Torque Pro (kff1001 is stable calculated speed)
    let rawSpeedKmh = parseFloat(req.query.kff1001) || parseFloat(req.query.k0d) || parseFloat(req.query.kff120c) || 0;
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let rawDistanceKm = parseFloat(req.query.kff1204) || 0;   

    // 2. Precise Conversion Math
    let speedMph = rawSpeedKmh * 0.621371; // Converts stable speed KM/H directly to perfect MPH
    
    // Safety filter for speed jitter when idling or parked
    if (speedMph < 1.0 || speedMph > 100) {
        speedMph = 0;
    }
    
    // Convert raw trip distance from kilometers to miles cleanly
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Dynamic efficiency curve tracking your speed profile
    let dynamicEfficiency = 4.2; 
    if (speedMph > 65) dynamicEfficiency = 3.4; 
    if (speedMph === 0) dynamicEfficiency = 0.0;

    // 3. Package completely clean, pre-scaled numbers for the stream overlay
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", // Changed to 2 decimals so tiny drives (.12 mi) show up perfectly!
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
