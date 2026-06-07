const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 2026 IRS Standard Mileage Rate for Business Deductions
const MILEAGE_RATE = 0.725; 

// Base health-check endpoint for web browser verification
app.get('/', (req, res) => {
    res.send('Telemetry server is up and running!');
});

// This is the direct API endpoint Torque Pro pings on its web logging cycle
app.get('/live', (req, res) => {
    // 1. Pull the raw telemetry parameters out of the incoming URL query string
    // PRIORITIZATION: 
    // - k5: OBD Speed (from the car's physical tires - works perfectly in the background)
    // - k0d: Alternate OBD Wheel Speed sensor
    // - kff1001: Standard Calculated Speed
    // - kff120c: GPS Fallback
    let rawSpeedKmh = parseFloat(req.query.k5) || parseFloat(req.query.k0d) || parseFloat(req.query.kff1001) || parseFloat(req.query.kff120c) || 0;
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let rawDistanceKm = parseFloat(req.query.kff1204) || 0;   
    let rawAmbientCelsius = req.query.k46 ? parseFloat(req.query.k46) : null; // PID k46 is Ambient Air Temp

    // 2. Exact Metric-to-Imperial Math Conversions
    let speedMph = rawSpeedKmh * 0.621371; 
    
    // Safety filter to catch and drop speed jitter when idling, stopped, or parked
    if (speedMph < 1.0 || speedMph > 100) {
        speedMph = 0;
    }
    
    // Convert raw trip tracking distance cleanly from kilometers into perfect miles
    let tripDistance = rawDistanceKm * 0.621371;
    if (tripDistance < 0) tripDistance = 0;
    
    // Calculate total dynamic business tax deductions write-offs for the shift
    let taxSaved = tripDistance * MILEAGE_RATE;

    // Convert Ambient Temp to Fahrenheit if available
    let tempFahrenheit = "--°F";
    if (rawAmbientCelsius !== null) {
        tempFahrenheit = Math.round((rawAmbientCelsius * 9/5) + 32) + "°F";
    }

    // CONSERVATIVE EFFICIENCY ENGINE (Tuned down to match real-world delivery conditions)
    let dynamicEfficiency = 3.6;                  // City stop-and-go sweet spot
    if (speedMph > 65) dynamicEfficiency = 2.8;   // Highway aerodynamic wind drag penalty
    if (speedMph === 0) dynamicEfficiency = 0.0;  // Parked / Stopped layout drop

    // 3. Package clean, pre-scaled numbers into a lightweight JSON payload
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

    // 4. Broadcast the data payload to the StreamElements widget via WebSockets
    io.emit('telemetry_update', telemetryData);

    // 5. Reply OK to Torque Pro to acknowledge a successful upload packet
    res.send('OK!');
});

// Dynamically bind to the port assigned by Render or fallback to local port 3000
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
