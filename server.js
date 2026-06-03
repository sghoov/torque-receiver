const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// This memory variable holds your car's live data
let liveTelemetry = {};

// 1. Tell the server to allow StreamElements to read the data safely (CORS)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// 2. This route catches the live data stream blasting from Torque Pro
app.get('/upload', (req, res) => {
    // Acknowledge Torque immediately so it keeps streaming smoothly
    res.send('OK!');

    // Check if Torque actually sent data parameters
    if (Object.keys(req.query).length > 0) {
        // Overwrite the live telemetry object with the newest frame
        liveTelemetry = req.query;
    }
});

// 3. This route is what your StreamElements widget will pull from
app.get('/live', (req, res) => {
    res.json(liveTelemetry);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Telemetry server is running on port ${PORT}`);
});
