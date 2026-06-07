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
    // 1. Pull true car wheel speed and distance registers from Torque
    let rawSpeedKmh = parseFloat(req.query.k5) || parseFloat(req.query.k0d) || parseFloat(req.query.kff1001) || 0;
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let rawDistanceKm = parseFloat(req.query.kff1204) || 0;   
    let rawAmbientCelsius = req.query.k46 ? parseFloat(req.query.k46) : null; 

    // 2. Conversion Math
    let speedMph = rawSpeedKmh * 0.621371; 
    if (speedMph < 1.0 || speedMph > 100) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temp to Fahrenheit with the +1 dashboard offset
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // 3. EFFICIENCY ENGINE (Locked to your 4.2 City Baseline)
    let dynamicEfficiency = "4.2 mi/kWh";                     // City sweet spot
    if (speedMph > 45) dynamicEfficiency = "2.8 mi/kWh";   // Highway wind drag penalty
    if (speedMph === 0) dynamicEfficiency = "0.0 mi/kWh";  // Stopped / Idle state

    // 4. Package clean payload
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: dynamicEfficiency, 
        temperature: tempFahrenheit,
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
