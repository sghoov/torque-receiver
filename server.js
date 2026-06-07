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
    // 1. Pull raw parameters
    let rawSpeedKmh = parseFloat(req.query.kff1001) || parseFloat(req.query.k0d) || parseFloat(req.query.kff120c) || 0;
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let rawDistanceKm = parseFloat(req.query.kff1204) || 0;   
    let rawAmbientCelsius = req.query.k46 ? parseFloat(req.query.k46) : null; // PID k46 is Ambient Air Temp

    // 2. Math Conversions
    let speedMph = rawSpeedKmh * 0.621371; 
    if (speedMph < 1.0 || speedMph > 100) speedMph = 0;
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temp to Fahrenheit if available
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = Math.round((rawAmbientCelsius * 9/5) + 32) + "°F";
    }

    // Conservative Efficiency
    let dynamicEfficiency = 3.6;                  
    if (speedMph > 65) dynamicEfficiency = 2.8;   
    if (speedMph === 0) dynamicEfficiency = 0.0;  

    // 3. Package Payload
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: dynamicEfficiency.toFixed(1) + " mi/kWh", 
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
