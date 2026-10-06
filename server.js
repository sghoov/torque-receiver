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
    fetch: fetch // Native fetch in Node 18+
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

async function uploadToDropbox(filename, content) {
    if (!process.env.DROPBOX_REFRESH_TOKEN) return;
    try {
        const cleanPath = filename.startsWith('/') ? filename : '/' + filename;
        return await dbx.filesUpload({
            path: cleanPath,
            contents: String(content),
            mode: { '.tag': 'overwrite' }
        });
    } catch (err) {
        console.error(`[Dropbox Upload Error - ${filename}]:`, err.status || err.message);
    }
}

async function copyDropboxLogo(sourceLogoFilename) {
    if (!process.env.DROPBOX_REFRESH_TOKEN || !sourceLogoFilename) return;
    try {
        await dbx.filesCopyV2({
            from_path: '/logos/' + sourceLogoFilename,
            to_path: '/gig logo.png',
            autorename: false,
            mode: { '.tag': 'overwrite' }
        });
        console.log(`[Dropbox Logo Sync] Successfully copied /logos/${sourceLogoFilename} -> /gig logo.png`);
    } catch (err) {
        console.error(`[Dropbox Logo Copy Error]:`, err.status || err.message);
    }
}

// Helper to safely fetch shift_stats.json using Buffer parsing
async function getShiftStatsFromDropbox() {
    let defaultStats = { 
        app_tips: "0.00", 
        stream_tips: "0.00", 
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
        return stats;
    } catch (e) {
        console.log('shift_stats.json not found on Dropbox or failed to read, initializing fresh state...');
        return defaultStats;
    }
}

// Helper to safely read a floating-point value from Dropbox file or fallback to stats
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

// STICKY GPS STORAGE: Default to Pacifica
let currentLat = 37.6017; 
let currentLon = -122.4868;

app.get('/', (req, res) => {
    res.send('Telemetry physics engine server is up and running safely!');
});

app.get('/current-city', (req, res) => {
    res.json({ lat: currentLat, lon: currentLon });
});

app.get('/update-range', (req, res) => {
    try {
        // 1. FULL SHIFT RESET (New Day / New Stream)
        if (req.query.fullReset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            savedPreviousTripsMiles = 0.0;
            lastKnownRawMiles = 0.0;
            shiftStartTime = null; // Resets shift timer back to 0:00
            rangeDistanceBaseline = latestRawDistanceMiles;
            sessionMilesBaseline = latestRawDistanceMiles;

            io.emit('shift_reset');
            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Shift Reset] Full stream shift clock, miles, and range reset executed.`);
            return res.send(`Success: Full shift clock, session miles, and range reset to 0!`);
        }

        // 2. MID-STREAM CHARGE RESET
        if (req.query.reset === 'true') {
            accumulatedTerrainAdjustmentMiles = 0.0;
            lastKnownAltitudeMeters = null;
            
            rangeDistanceBaseline = latestRawDistanceMiles;

            io.emit('manual_range_update', {
                startMiles: shortcutStartMiles !== null ? shortcutStartMiles : 0,
                maxRangeInput: shortcutMaxRange !== null ? shortcutMaxRange : 70
            });

            console.log(`[Battery Charge Reset] Range baseline set to: ${rangeDistanceBaseline.toFixed(2)} mi`);
            return res.send(`Success: Range bar reset to 70mi! (Shift time & total miles kept intact)`);
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
            tax: "$" + taxSaved.toFixed(2)
        };

        io.emit('telemetry_update', telemetryData);
        res.send('OK!');

    } catch (liveError) {
        console.error('Error handling live Torque packet:', liveError.message);
        res.send('OK!');
    }
});

// =========================================================================
// AI OFFER CARD PARSER (/parse-offer)
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

        // Restored original working model string
        const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });

        const prompt = `Analyze this gig delivery offer card screenshot from one of these platforms: 
DoorDash, Uber Eats, Instacart, Amazon Flex, Shipt, or Roadie.

Extract the following details and return ONLY a valid JSON object with no markdown formatting:
{
  "app_name": "DoorDash | Uber Eats | Instacart | Amazon Flex | Shipt | Roadie",
  "merchant": "Store or Restaurant Name",
  "pay": 0.00,
  "miles": 0.0,
  "tip": 0.00
}

Rules:
1. "pay" is the total earnings payout shown on the offer card.
2. "tip" is the explicit tip amount if broken down on the card (e.g., Instacart tip line item). If no tip is broken down separately, set "tip" to 0.00.
3. "merchant" is the pickup store/restaurant (e.g., "Costco", "McDonald's", "Safeway", "Amazon DSH1"). If unknown, set to "DELIVERY OFFER".`;

        const imageParts = [{ inlineData: { data: cleanBase64, mimeType: 'image/png' } }];
        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error(`Gemini response did not contain JSON: ${responseText}`);
        }

        const parsedData = JSON.parse(jsonMatch[0]);

        const appName = parsedData.app_name || 'DoorDash';
        const merchant = (parsedData.merchant || 'DELIVERY OFFER').toUpperCase();
        const payNum = parseFloat(parsedData.pay || 0);
        const milesNum = parseFloat(parsedData.miles || 0);
        const tipNum = parseFloat(parsedData.tip || 0);

        const pay = payNum.toFixed(2);
        const miles = milesNum.toFixed(1);

        // Fetch theme metadata (color & logo)
        const theme = APP_THEMES[appName] || { color: "#FF3008", logoFilename: "dd logo.png" };

        // Fetch current stats from Dropbox JSON
        let currentStats = await getShiftStatsFromDropbox();

        // Safe Fallback Base Numbers from current JSON state
        let baseGrandTotal = parseFloat(currentStats.grand_total || 0);
        let baseTotalMiles = parseFloat(currentStats.total_miles || 0);

        // Read direct file values with JSON fallback
        let existingGrandTotal = await readDropboxFloat('/total.txt', baseGrandTotal);
        let existingTotalMiles = await readDropboxFloat('/miles.txt', baseTotalMiles);

        // Add current accepted offer to totals
        let newGrandTotal = (existingGrandTotal + payNum).toFixed(2);
        let newTotalMiles = (existingTotalMiles + milesNum).toFixed(1);

        // Update shift stats object
        currentStats.grand_total = newGrandTotal;
        currentStats.total_miles = newTotalMiles;
        if (tipNum > 0) {
            currentStats.app_tips = (parseFloat(currentStats.app_tips || 0) + tipNum).toFixed(2);
        }

        // Add to history stack for rollback capability
        const offerRecord = {
            id: Date.now(),
            appName,
            merchant,
            pay: payNum,
            miles: milesNum,
            tip: tipNum,
            timestamp: new Date().toISOString()
        };
        currentStats.offer_history.push(offerRecord);
        currentStats.lastUpdated = new Date().toISOString();

        // Build comprehensive JSON payload for StreamElements widgets
        const offerDataJSON = {
            appName,
            merchant,
            pay: `$${pay}`,
            miles: miles,
            theme: {
                primaryColor: theme.color,
                logo: theme.logoFilename
            },
            updatedAt: currentStats.lastUpdated
        };

        // Batch upload files to Dropbox - synchronized both miles.txt and mile.txt
        const uploadPromises = [
            // Current Offer Text Files
            uploadToDropbox('merchant_name.txt', merchant),
            uploadToDropbox('current_offer.txt', `$${pay}`),
            uploadToDropbox('offer_miles.txt', miles),
            uploadToDropbox('app_name.txt', appName),
            uploadToDropbox('app_color.txt', theme.color),
            uploadToDropbox('offer_data.json', JSON.stringify(offerDataJSON, null, 2)),

            // Running Shift Totals (Synchronized both miles.txt and mile.txt)
            uploadToDropbox('total.txt', `$${newGrandTotal}`),
            uploadToDropbox('miles.txt', newTotalMiles),
            uploadToDropbox('mile.txt', newTotalMiles),
            uploadToDropbox('shift_stats.json', JSON.stringify(currentStats, null, 2))
        ];

        if (tipNum > 0) {
            uploadPromises.push(uploadToDropbox('doordash_tips.txt', currentStats.app_tips));
        }

        await Promise.all(uploadPromises);

        // Sync logo image on Dropbox asynchronously
        copyDropboxLogo(theme.logoFilename);

        res.json({
            status: 'success',
            data: { appName, merchant, pay: `$${pay}`, miles, newGrandTotal: `$${newGrandTotal}`, newTotalMiles }
        });

    } catch (err) {
        console.error('AI Offer Parsing Error Detail:', err.message || err);
        res.status(500).json({ error: 'Failed to parse offer card screenshot', details: err.message });
    }
});

// =========================================================================
// REMOVE LAST OFFER ENDPOINT (/remove-offer)
// =========================================================================
app.post('/remove-offer', async (req, res) => {
    try {
        let currentStats = await getShiftStatsFromDropbox();

        if (!currentStats.offer_history || currentStats.offer_history.length === 0) {
            return res.json({
                status: 'error',
                message: 'No recent offer found in history to remove.'
            });
        }

        // Pop last accepted offer from history stack
        const lastOffer = currentStats.offer_history.pop();

        // Read current running totals
        let baseGrandTotal = parseFloat(currentStats.grand_total || 0);
        let baseTotalMiles = parseFloat(currentStats.total_miles || 0);

        let existingGrandTotal = await readDropboxFloat('/total.txt', baseGrandTotal);
        let existingTotalMiles = await readDropboxFloat('/miles.txt', baseTotalMiles);

        // Deduct last offer metrics (ensuring totals don't dip below 0)
        let newGrandTotal = Math.max(0, existingGrandTotal - lastOffer.pay).toFixed(2);
        let newTotalMiles = Math.max(0, existingTotalMiles - lastOffer.miles).toFixed(1);

        currentStats.grand_total = newGrandTotal;
        currentStats.total_miles = newTotalMiles;
        if (lastOffer.tip > 0) {
            currentStats.app_tips = Math.max(0, parseFloat(currentStats.app_tips || 0) - lastOffer.tip).toFixed(2);
        }
        currentStats.lastUpdated = new Date().toISOString();

        // Update Dropbox text files and state
        const uploadPromises = [
            uploadToDropbox('current_offer.txt', '$0.00'),
            uploadToDropbox('offer_miles.txt', '0.0'),
            uploadToDropbox('merchant_name.txt', '[CANCELED]'),
            uploadToDropbox('total.txt', `$${newGrandTotal}`),
            uploadToDropbox('miles.txt', newTotalMiles),
            uploadToDropbox('mile.txt', newTotalMiles),
            uploadToDropbox('shift_stats.json', JSON.stringify(currentStats, null, 2))
        ];

        await Promise.all(uploadPromises);

        res.json({
            status: 'success',
            message: `Removed $${lastOffer.pay.toFixed(2)} / ${lastOffer.miles} mi (${lastOffer.merchant})`,
            data: {
                removedOffer: lastOffer,
                newGrandTotal: `$${newGrandTotal}`,
                newTotalMiles
            }
        });

    } catch (err) {
        console.error('Remove Offer Error:', err.message || err);
        res.status(500).json({ error: 'Failed to remove last offer', details: err.message });
    }
});

// =========================================================================
// MANUAL TIP RECEIVER (/add-tip)
// =========================================================================
app.post('/add-tip', async (req, res) => {
    try {
        const { amount, app_name } = req.body;
        const tipAmount = parseFloat(amount || 0);

        if (isNaN(tipAmount) || tipAmount <= 0) {
            return res.status(400).json({ error: 'Invalid tip amount' });
        }

        let currentStats = await getShiftStatsFromDropbox();

        const updatedAppTips = (parseFloat(currentStats.app_tips || 0) + tipAmount).toFixed(2);
        const updatedGrandTotal = (parseFloat(currentStats.grand_total || 0) + tipAmount).toFixed(2);

        currentStats.app_tips = updatedAppTips;
        currentStats.grand_total = updatedGrandTotal;
        currentStats.lastUpdated = new Date().toISOString();

        await Promise.all([
            uploadToDropbox('shift_stats.json', JSON.stringify(currentStats, null, 2)),
            uploadToDropbox('doordash_tips.txt', updatedAppTips),
            uploadToDropbox('total.txt', `$${updatedGrandTotal}`)
        ]);

        res.json({
            status: 'success',
            data: {
                app_tips: updatedAppTips,
                stream_tips: currentStats.stream_tips || "0.00",
                grand_total: `$${updatedGrandTotal}`
            }
        });

    } catch (err) {
        console.error('Add Tip Error:', err);
        res.status(500).json({ error: 'Failed to record tip' });
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
