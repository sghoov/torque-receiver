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
    // 1. CATCH-ALL SPEED NET: Listens to every common Torque Pro speed PID (OBD, GPS, and Alternate Wheel Sensors)
    let rawSpeedKmh = 
        parseFloat(req.query.k5) ||       // OBD Speed (Standard)
        parseFloat(req.query.k0d) ||      // Engine Speed sensor
        parseFloat(req.query.kff1202) ||  // Universal GPS Speed register
        parseFloat(req.query.kff1001) ||  // GPS Speed (Alternate)
        parseFloat(req.query.v) ||        // Raw Velocity string
        0;

    let rawDistanceKm = parseFloat(req.query.kff1204) || 0;   
    let rawAmbientCelsius = req.query.k46 ? parseFloat(req.query.k46) : null; 

    // MULTI-PID ELEVATION SAFETY NET: Looks for GPS altitude, alternative altitude, or barometer height
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || parseFloat(req.query.kff122b) || parseFloat(req.query.kff1206) || 0; 

    // 2. Adaptive Speed Processing (Fixes the low-end clamp bug)
    let speedMph = rawSpeedKmh;
    // If the value is raw KMH data, convert it; otherwise keep it as direct MPH
    if (speedMph > 150) { 
        speedMph = rawSpeedKmh * 0.621371;
    }
    // Simple noise floor clamp so it only drops to zero if the vehicle is genuinely stopped
    if (speedMph < 0.2 || speedMph > 110) {
        speedMph = 0;
    }
    
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temp to Fahrenheit with the +1 dashboard offset calibration
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
    }

    // Convert Altitude precisely to feet
    let elevationDisplay = "-- ft";
    if (rawAltitudeMeters !== 0) {
        elevationDisplay = Math.round(rawAltitudeMeters * 3.28084) + " ft";
    }

    // 3. Package clean, pre-scaled data payload for the stream overlay banner
    const telemetryData = {
        distance: tripDistance.toFixed(2) + " mi", 
        speed: Math.round(speedMph) + " mph",
        elevation: elevationDisplay, 
        temperature: tempFahrenheit,
        tripMilesRaw: tripDistance,
        rawSpeed: speedMph,
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. Pipe data instantly to StreamElements
    io.emit('telemetry_update', telemetryData);
    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
