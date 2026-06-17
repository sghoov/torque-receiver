const express = require('express');
const app = express();
const http = require('http').createServer(app);

// A simple global object to hold the last raw data packet received from your phone
let lastRawData = {
    message: "No data received yet. Start driving with Torque Pro active."
};

app.get('/', (req, res) => {
    // Elegant, auto-refreshing diagnostic dashboard viewable on any browser
    res.send(`
        <html>
            <head>
                <meta http-equiv="refresh" content="1">
                <style>
                    body { font-family: monospace; background: #0a0e12; color: #00ffcc; padding: 40px; font-size: 18px; }
                    h1 { color: #ffffff; border-bottom: 2px solid #333; padding-bottom: 10px; }
                    pre { background: #141a22; padding: 20px; border-radius: 8px; border: 1px solid #223344; color: #ff9900; }
                    .highlight { color: #00ff00; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>📡 Papa Gigs Telemetry Diagnostic Console</h1>
                <p>This page automatically refreshes every 1 second to show live incoming phone values.</p>
                <h3>Last Received Data Packet:</h3>
                <pre>${JSON.stringify(lastRawData, null, 2)}</pre>
            </body>
        </html>
    `);
});

app.get('/live', (req, res) => {
    // Capture every single potential speed variable straight from the incoming URL query
    lastRawData = {
        timestamp: new Date().toLocaleTimeString(),
        "k5 (Standard OBD Speed)": req.query.k5 || "Missing",
        "k0d (Engine/Wheel Speed)": req.query.k0d || "Missing",
        "kff1202 (Universal GPS Speed)": req.query.kff1202 || "Missing",
        "kff1001 (Alternate GPS Speed)": req.query.kff1001 || "Missing",
        "v (Raw Velocity String)": req.query.v || "Missing",
        "Full Incoming URL Parameters Passed": req.query
    };

    res.send('OK!');
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Diagnostic server listening on port ${PORT}`);
});
