const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const { Dropbox } = require('dropbox');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Middleware for JSON/base64 payload support
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// External API Clients - Permanent Refresh Token Auth
const dbx = new Dropbox({
    clientId: process.env.DROPBOX_APP_KEY,
    clientSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    fetch: fetch
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// APP BRAND THEME MAP
const APP_THEMES = {
    "DoorDash": { color: "#FF3008", logoFilename: "dd logo.png" },
    "Uber Eats": { color: "#06C167", logoFilename: "uber eats logo.png" },
    "Instacart": { color: "#00A254", logoFilename: "insta logo.png" },
    "Amazon Flex": { color: "#00A8E8", logoFilename: "flex logo1.png" },
    "Shipt": { color: "#00B2A9", logoFilename: "shipt logo.png" },
    "Roadie": { color: "#C02823", logoFilename: "roadie logo.png" }
};

// Rate-limit resistant upload helper with exponential backoff retry logic
async function uploadToDropbox(filename, content, retries = 3, delay = 400) {
    if (!process.env.DROPBOX_REFRESH_TOKEN) return;
    const cleanPath = filename.startsWith('/') ? filename : '/' + filename;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await dbx.filesUpload({
                path: cleanPath,
                contents: String(content),
                mode: { '.tag': 'overwrite' }
            });
        } catch (err) {
            const status = err.status || (err.error && err.error.status);
            if ((status === 429 || status === 409) && attempt < retries) {
                console.warn(`[Dropbox ${status} - ${filename}] Retrying attempt ${attempt}/${retries} in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                console.error(`[Dropbox Upload Error - ${filename}]:`, status || err.message);
                break;
            }
        }
    }
}

// In-place byte copy to overwrite /gig logo.png without deleting it
async function copyDropboxLogo(sourceLogoFilename) {
    if (!process.env.DROPBOX_REFRESH_TOKEN || !sourceLogoFilename) return;
    try {
        const fileDownload = await dbx.filesDownload({ path: '/logos/' + sourceLogoFilename });
        
        let logoBuffer;
        if (fileDownload.result.fileBinary) {
            logoBuffer = fileDownload.result.fileBinary;
        } else {
            logoBuffer = Buffer.from(fileDownload.result.fileBinary);
        }

        await dbx.filesUpload({
            path: '/gig logo.png',
            contents: logoBuffer,
            mode: { '.tag': 'overwrite' }
        });
        
        console.log(`[Dropbox Logo Sync] Overwrote /gig logo.png in-place with /logos/${sourceLogoFilename}`);
    } catch (err) {
        console.error(`[Dropbox Logo Copy Error]:`, err.status || err.message);
    }
}

// Helper to safely fetch shift_stats.json using Buffer parsing
async function getShiftStatsFromDropbox() {
    let defaultStats = { 
        app_tips: "0.00", 
        stream_tips: "0.00", 
        other_donations: "0.00",
        superchats: "0.00",
        jewels: 0,
        members: 0,
        subs: 0,
        shift_start_subs: null,
        grand_total: "0.00",
        total_miles: "0.0",
        offer_history: [] 
    };
    try {
        const fileDownload = await dbx.filesDownload({ path: '/shift_stats.json' });
        
        let contents;
        if (fileDownload.result.fileBinary) {
            contents = Buffer.from(fileDownload.result.fileBinary).toString('utf-8');
        } else {
            contents = fileDownload.result.fileBinary;
        }

        const stats = JSON.parse(contents);
        if (!stats.offer_history) stats.offer_history = [];
        if (!stats.total_miles) stats.total_miles = "0.0";
        if (!stats.app_tips) stats.app_tips = "0.00";
        if (!stats.other_donations) stats.other_donations = "0.00";
        if (!stats.superchats) stats.superchats = "0.00";
        if (stats.jewels === undefined) stats.jewels = 0;
        if (stats.members === undefined) stats.members = 0;
        if (stats.subs === undefined) stats.subs = 0;
        if (stats.shift_start_subs === undefined) stats.shift_start_subs = null;
        return stats;
    } catch (e) {
        console.log('shift_stats.json not found on Dropbox or failed to read, initializing fresh state...');
        return defaultStats;
    }
}

// Helper to safely read current items from Dropbox JSON
async function getCurrentItemsFromDropbox() {
    try {
        const fileDownload = await dbx.filesDownload({ path: '/current_items.json' });
        let contents = fileDownload.result.fileBinary 
            ? Buffer.from(fileDownload.result.fileBinary).toString('utf-8') 
            : fileDownload.result.fileBinary;
        return JSON.parse(contents);
    } catch (e) {
        return { status: "DELIVERING", items: [] };
    }
}

// Helper to safely read a floating-point value from Dropbox file or default to 0
async function readDropboxFloat(filePath, defaultValue = 0.0) {
    try {
        const cleanPath = filePath.startsWith('/') ? filePath : '/' + filePath;
        const fileDownload = await dbx.filesDownload({ path: cleanPath });
        let contents = fileDownload.result.fileBinary ? Buffer.from(fileDownload.result.fileBinary).toString('utf-8') : fileDownload.result.fileBinary;
        let cleanVal = String(contents).replace(/[^0-9.]/g, '');
        let parsed = parseFloat(cleanVal);
        return isNaN(parsed) ? defaultValue : parsed;
    } catch (e) {
        return defaultValue;
    }
}

const MILEAGE_RATE = 0.725; // IRS Rate

// PERSISTENT SERVER STATE STORAGE
let shortcutStartMiles = null;
let shortcutMaxRange = null;

let lastKnownAltitudeMeters = null;
let accumulatedTerrainAdjustmentMiles = 0.0; 

// BASELINE SNAPSHOTS FOR RESETS
let rangeDistanceBaseline = 0.0; 
let sessionMilesBaseline = 0.0;
let latestRawDistanceMiles = 0.0;

// SHIFT TIMER STATE (SERVER-SIDE)
let shiftStartTime = null;

// TORQUE AUTO-RESET GUARD STATE
let savedPreviousTripsMiles = 0.0;
let lastKnownRawMiles = 0.0;

// STICKY GPS STORAGE
let currentLat = 37.6017; 
let currentLon = -122.4868;

app.get('/', (req, res) => {
    res.send('Telemetry physics engine server is up and running safely!');
});

app.get('/current-city', (req, res) => {
    res.json({ lat: currentLat, lon: currentLon });
});

// Helper function to perform a full shift wipe
async function executeShiftReset() {
    let freshStats = { 
        app_tips: "0.00", 
        stream_tips: "0.00", 
        other_donations: "0.00",
        superchats: "0.00",
        jewels: 0,
        members: 0,
        subs: 0,
        shift_start_subs: null,
        grand_total: "0.00",
        total_miles: "0.0",
        offer_history: [],
        lastUpdated: new Date().toISOString()
    };

    const emptyItemsObject = {
        status: "DELIVERING",
        items: []
    };

    const resetFiles = [
        { name: 'current_offer.txt', content: '\$0.00' },
        { name: 'offer_miles.txt', content: '0.0' },
        { name: 'merchant_name.txt', content: 'READY' },
        { name: 'offer_rank.txt', content: 'NONE' },
        { name: 'offer_reason.txt', content: '' },
        { name: 'total.txt', content: '\$0.00' },
        { name: 'miles.txt', content: '0.0' },
        { name: 'current_items.json', content: JSON.stringify(emptyItemsObject, null, 2) },
        { name: 'shift_stats.json', content: JSON.stringify(freshStats, null, 2) }
    ];

    for (const file of resetFiles) {
        await uploadToDropbox(file.name, file.content);
    }

    return freshStats;
}

// Full Shift Reset Route (Clears telemetry & tote board)
app.get('/reset-shift', async (req, res) => {
    try {
        await executeShiftReset();
        accumulatedTerrainAdjustmentMiles = 0.0;
        lastKnownAltitudeMeters = null;
        savedPreviousTripsMiles = 0.0;
        lastKnownRawMiles = 0.0;
        shiftStartTime = null;
        io.emit('shift_reset');

        console.log('[Shift Reset] Shift totals and telemetry successfully cleared.');
        res.json({ status: 'success', message: 'Shift stats reset to \$0.00 and 0.0 miles!' });
    } catch (err) {
        console.error('Reset Shift Error:', err.message || err);
        res.status(500).json({ error: 'Failed to reset shift', details: err.message });
    }
});

app.get('/update-range', (req, res) => {
    try {
        if (req.query.fullReset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            savedPreviousTripsMiles = 0.0;
            lastKnownRawMiles = 0.0;
            shiftStartTime = null;
            rangeDistanceBaseline = latestRawDistanceMiles;
            sessionMilesBaseline = latestRawDistanceMiles;

            io.emit('shift_reset');
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log('[Shift Reset] Full stream shift clock, miles, and range reset executed.');
            return res.send('Success: Full shift clock, session miles, and range reset to 0!');
        }

        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            rangeDistanceBaseline = latestRawDistanceMiles;

            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Battery Charge Reset] Range baseline set to: ${rangeDistanceBaseline.toFixed(2)} mi`);
            return res.send('Success: Range bar reset to 70mi!');
        }

        let parsedStart = parseFloat(req.query.startMiles);
        let parsedRange = parseFloat(req.query.maxRange);
        if (!isNaN(parsedStart)) shortcutStartMiles = parsedStart;
        if (!isNaN(parsedRange)) shortcutMaxRange = parsedRange;

        if (!isNaN(parsedStart) || !isNaN(parsedRange)) {
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });
            return res.send(`Updated! Start Miles: ${shortcutStartMiles}, Max Range: ${shortcutMaxRange}`);
        }
        return res.status(400).send('Error: No valid numeric parameters received.');
    } catch (error) {
        console.error('Shortcut endpoint error:', error.message);
        res.status(500).send('Error handled safely.');
    }
});

app.get('/live', async (req, res) => {
    try {
        const getParam = (key) => {
            let val = req.query[key] || req.query[key.toUpperCase()] || req.query[key.toLowerCase()];
            if (Array.isArray(val)) val = val[0];
            if (val === undefined || val === null || val === "" || isNaN(parseFloat(val))) return null;
            return parseFloat(val);
        };

        let rawSpeedKmh = getParam('kff1001') || 0;
        let speedMph = rawSpeedKmh * 0.621371;
        if (isNaN(speedMph) || speedMph < 0.8 || speedMph > 110) speedMph = 0;

        if (speedMph > 1.0 && shiftStartTime === null) {
            shiftStartTime = Date.now();
            console.log(`[Shift Timer] Started shift timer at ${new Date(shiftStartTime).toLocaleTimeString()}`);
        }

        let shiftDurationSeconds = shiftStartTime ? Math.floor((Date.now() - shiftStartTime) / 1000) : 0;

        let incomingDistanceKm = getParam('kff1204');
        let rawTripDistanceMiles = lastKnownRawMiles;

        if (incomingDistanceKm !== null) {
            let parsedMiles = incomingDistanceKm * 0.621371;
            
            if (!isNaN(parsedMiles) && parsedMiles > 0.01) {
                if (lastKnownRawMiles > 0 && parsedMiles > (lastKnownRawMiles + 5.0)) {
                    console.warn(`[Glitch Blocked] Ignored sudden jump from ${lastKnownRawMiles.toFixed(1)} to ${parsedMiles.toFixed(1)} mi`);
                    rawTripDistanceMiles = lastKnownRawMiles;
                } 
                else if (lastKnownRawMiles > 1.0 && parsedMiles < 0.5) {
                    savedPreviousTripsMiles += Math.max(0, lastKnownRawMiles - sessionMilesBaseline);
                    sessionMilesBaseline = 0.0;
                    rangeDistanceBaseline = 0.0;
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                    console.log(`[Torque Auto-Reset] Valid reset confirmed at ${parsedMiles.toFixed(2)} mi.`);
                } 
                else if (parsedMiles >= lastKnownRawMiles) {
                    rawTripDistanceMiles = parsedMiles;
                    lastKnownRawMiles = parsedMiles;
                }
            }
        }

        latestRawDistanceMiles = rawTripDistanceMiles;

        let currentUnweightedMiles = Math.max(0, rawTripDistanceMiles - sessionMilesBaseline);
        let trueSessionMiles = savedPreviousTripsMiles + currentUnweightedMiles;
        if (isNaN(trueSessionMiles)) trueSessionMiles = 0.0;

        let milesOnCurrentCharge = Math.max(0, rawTripDistanceMiles - rangeDistanceBaseline);
        let taxSaved = trueSessionMiles * MILEAGE_RATE;

        let hwyPercent = getParam('kff1297') || 0;
        let motorTorque = getParam('kff1225') || 0;

        let speedPenalty = 0.0;
        if (speedMph > 53) {
            speedPenalty = Math.min(0.18, ((speedMph - 53) / 17) * 0.18); 
        }
        let hwyPenalty = (hwyPercent / 100) * 0.10; 
        let styleMultiplier = 1.0 + speedPenalty + hwyPenalty;

        let baseWeightedMiles = (milesOnCurrentCharge * styleMultiplier) * 1.05;

        let rawAltitudeMeters = getParam('kff1010');
        
        if (speedMph > 2 && rawAltitudeMeters !== null) {
            if (lastKnownAltitudeMeters !== null && !isNaN(lastKnownAltitudeMeters)) {
                let deltaMeters = rawAltitudeMeters - lastKnownAltitudeMeters;
                let deltaFeet = deltaMeters * 3.28084;
                
                if (deltaFeet > 3.0 && deltaFeet < 120.0) { 
                    let climbWeight = deltaFeet * 0.005; 
                    accumulatedTerrainAdjustmentMiles += climbWeight;
                }
            }
            lastKnownAltitudeMeters = rawAltitudeMeters;

            if (motorTorque <= 0) {
                let regenCreditPerSecond = (speedMph / 3600) * 0.20; 
                accumulatedTerrainAdjustmentMiles -= regenCreditPerSecond;
            }
        }

        let adjustedTripDistanceMiles = baseWeightedMiles + accumulatedTerrainAdjustmentMiles;
        if (isNaN(adjustedTripDistanceMiles) || adjustedTripDistanceMiles < 0) adjustedTripDistanceMiles = 0; 

        let rawAmbientCelsius = getParam('k46');
        let tempFahrenheit = "--°F";
        if (rawAmbientCelsius !== null) {
            tempFahrenheit = (Math.round((rawAmbientCelsius * 9/5) + 32) + 1) + "°F";
        }

        let elevationDisplay = "-- ft";
        if (rawAltitudeMeters !== null) {
            let trueFeet = (rawAltitudeMeters * 3.28084) + 104; 
            elevationDisplay = Math.round(trueFeet) + " ft";
        }

        let rawBearing = getParam('kff123b');
        let compassHeading = "--";
        if (rawBearing !== null) {
            const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
            let index = Math.round(((rawBearing % 360) / 45)) % 8;
            compassHeading = directions[index];
        }

        let latIn = getParam('kff1006');
        if (latIn !== null && latIn !== 0) currentLat = latIn;

        let lonIn = getParam('kff1005');
        if (lonIn !== null && lonIn !== 0) currentLon = lonIn;

        const telemetryData = {
            distance: adjustedTripDistanceMiles.toFixed(1) + " mi", 
            speed: Math.round(speedMph) + " mph",
            elevation: elevationDisplay, 
            temperature: tempFahrenheit,
            compass: compassHeading,
            lat: currentLat, 
            lon: currentLon,
            tripMilesRaw: adjustedTripDistanceMiles,
            actualSessionMilesRaw: trueSessionMiles,
            shiftSeconds: shiftDurationSeconds,
            rawSpeed: speedMph,
            tax: "\$" + taxSaved.toFixed(2)
        };

        io.emit('telemetry_update', telemetryData);
        res.send('OK!');

    } catch (liveError) {
        console.error('Error handling live Torque packet:', liveError.message);
        res.send('OK!');
    }
});

// =========================================================================
// AI OFFER CARD PARSER (/parse-offer) WITH DIRECT AI RATING & REASONING
// =========================================================================
app.post('/parse-offer', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'No image provided' });
        }

        const cleanBase64 = String(imageBase64)
            .replace(/^data:image\/\w+;base64,/, '')
            .replace(/\s+/g, '');

        const model =
