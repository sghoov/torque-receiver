// This is the endpoint Torque Pro pings every second
app.get('/live', (req, res) => {
    // 1. Pull the data out of the incoming URL query parameters
    let rawSpeedKmh = parseFloat(req.query.kff120c) || 0;    
    let rawAltitudeMeters = parseFloat(req.query.kff1238) || 0; 
    let tripDistance = parseFloat(req.query.kff1204) || 0;   

    // 2. Perform the calculations
    let speedMph = rawSpeedKmh * 0.621371;
    let taxSaved = tripDistance * 0.725; // 2026 IRS Rate
    let virtualRange = Math.max(0, 75 - tripDistance);

    // 3. Package the numbers for the StreamElements listener
    const telemetryData = {
        distance: tripDistance.toFixed(1) + " mi",
        speed: Math.round(speedMph) + " mph",
        elevation: Math.round(rawAltitudeMeters * 3.28084) + " ft", 
        efficiency: (speedMph > 0 ? "4.2" : "0.0") + " mi/kWh", // Placeholder calculation
        range: Math.round(virtualRange) + " mi",
        rangePercent: Math.round((virtualRange / 75) * 100),
        tax: "$" + taxSaved.toFixed(2)
    };

    // 4. FIRE THE WEBSOCKET PULSE (This triggers the widget!)
    io.emit('telemetry_update', telemetryData);

    // 5. Reply with a clean 'OK!' to Torque Pro instead of raw JSON data
    res.send('OK!');
});
