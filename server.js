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

// Base endpoint for web browser verification
app.get('/', (req, res) => {
    res.send('Telemetry server is up and running!');
});

// This is the endpoint Torque Pro pings every second
app.get('/live', (req, res) => {
    // 1. Pull the data out of the incoming URL query parameters
    let rawSpeedKmh = parseFloat(req.query.kff120c) || 0;    
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let tripDistance = parseFloat(req.query.kff1204) || 0;   

    // 2. Perform the calculations
    let speedMph = rawSpeedKmh * 0.621371;
    let taxSaved = tripDistance * MILEAGE_RATE;
    let virtualRange = Math.max(0, 75 - tripDistance);

    // Dynamic efficiency curve matching your driving behavior
    let dynamicEfficiency = 4.2; 
    if (speedMph > 65) dynamicEfficiency = 3.4; 
    if (speedMph === 0) dynamicEfficiency = 0.0;

    // 3. Package the numbers for the StreamElements listener
    const telemetryData = {
        distance: tripDistance.toFixed(1) + " mi",
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: dynamicEfficiency.toFixed(1) + " mi/kWh", 
        range: Math.round(virtualRange) + " mi",
        rangePercent: Math.round((virtualRange / 75) * 100),
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. Fire the WebSocket pulse to the widget
    io.emit('telemetry_update', telemetryData);

    // 5. Reply OK to Torque Pro
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
