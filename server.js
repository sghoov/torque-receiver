const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" } // Allows the StreamElements overlay to connect securely
});

const MILEAGE_RATE = 0.725; // 2026 IRS Rate

// Serve a basic page for the main URL
app.get('/', (req, res) => {
    res.send('Telemetry server is up and running!');
});

// This is the endpoint Torque Pro pings every second
app.get('/live', (req, res) => {
    // Extracting Torque's native web upload parameters
    let rawSpeed = parseFloat(req.query.kff1005) || 0;     // Speed in MPH
    let rawAltitude = parseFloat(req.query.kff1006) || 0;  // Altitude in meters
    let tripDistance = parseFloat(req.query.kff1204) || 0;  // Trip distance in miles
    let pedalPosition = parseFloat(req.query.k5) || 30;     // Throttle pedal %

    // Run the EV math hacks
    let taxSaved = tripDistance * MILEAGE_RATE;
    
    // Dynamic efficiency curve matching your driving behavior
    let dynamicEfficiency = 4.9; 
    if (pedalPosition > 50) dynamicEfficiency = 2.8;
    if (pedalPosition > 80) dynamicEfficiency = 1.9;
    if (rawSpeed === 0) dynamicEfficiency = 0.0;

    // Range calculation ticking down from the 75-mile baseline
    let virtualRange = Math.max(0, 75 - tripDistance);

    // Package everything into a clean update for the stream widget
    const telemetryData = {
        distance: tripDistance.toFixed(1) + " mi",
        speed: Math.round(rawSpeed) + " mph",
        elevation: Math.round(rawAltitude * 3.28084) + " ft", // Convert meters to feet
        efficiency: dynamicEfficiency.toFixed(1) + " mi/kWh",
        range: Math.round(virtualRange) + " mi",
        rangePercent: Math.round((virtualRange / 75) * 100),
        tax: "$" + taxSaved.toFixed(2)
    };

    // Shoot the data straight to StreamElements via WebSockets instantly
    io.emit('telemetry_update', telemetryData);

    // Respond OK so Torque Pro knows the connection is solid
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
