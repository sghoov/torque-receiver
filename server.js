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

    const emptyOfferObject = {
        pay: "\$0.00",
        miles: "0.0",
        merchant: "READY",
        rank: "NONE",
        reason: "",
        timestamp: Date.now()
    };

    const resetFiles = [
        { name: 'current_offer.json', content: JSON.stringify(emptyOfferObject, null, 2) },
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
// AI OFFER CARD PARSER (/parse-offer) WITH SINGLE JSON OUTPUT
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

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `Analyze this gig delivery offer card or order details screenshot from one of these platforms: 
DoorDash, Uber Eats, Instacart, Amazon Flex, Shipt, or Roadie.

Extract the details and evaluate the offer quality using the ranking rules below.

### RANKING RULES:
1. "BANGER!" - High payout, high rate per mile ($2.00+/mile), short time commitment, or great overall offer value.
2. "SOLID" - Fair payout ($1.50 - $2.00/mile), reliable merchant, reasonable distance.
3. "MEH" - Borderline payout ($1.00 - $1.50/mile), average offer.
4. "DESPERATE" - Low payout (<$1.00/mile), long distance, high effort. You can also use spooky Halloween terms like "SCARY" or "GHOST TOWN" with attitude!
5. "SUS!" - Red flags present (e.g. extremely low pay for high miles, suspicious store/distance ratio, multi-stop nightmare).

Extract the details and return ONLY a valid JSON object with no markdown formatting:
{
  "app_name": "DoorDash | Uber Eats | Instacart | Amazon Flex | Shipt | Roadie",
  "merchant": "Store or Restaurant Name",
  "pay": 0.00,
  "miles": 0.0,
  "tip": 0.00,
  "stops": 1,
  "is_alcohol": false,
  "is_shop_and_deliver": false,
  "is_shopping": false,
  "item_count": 0,
  "items": [],
  "rank": "BANGER! | SOLID | MEH | DESPERATE | SCARY | SUS!",
  "reason": "Short 1-sentence funny/punchy explanation of why you gave this rating with some attitude"
}

Rules:
1. "pay" is the total earnings payout shown on an offer card. If no dollar payout is visible, set "pay" to 0.00.
2. "miles" is the distance miles shown on an offer card. If no distance is visible, set "miles" to 0.0.
3. "merchant" is the pickup store/restaurant. If unknown, set to "".
4. "stops" is the number of pickups + dropoffs / order stops.
5. "is_alcohol" is true if the offer mentions alcohol, wine, beer, restricted item or ID verification required.
6. "is_shop_and_deliver" is true if it requires red card shopping, grocery picking, shop & deliver or Instacart/Shipt shopping.
7. "is_shopping" is true if this is an Instacart or Shipt order, OR if it's a grocery/retail/store Shop & Deliver run.
8. "item_count" is the total number of items shown if it is a shop & deliver or grocery order.
9. "items" is an array of strings containing ONLY primary food menu items or grocery items with quantities.
10. "rank" MUST be one of: "BANGER!", "SOLID", "MEH", "DESPERATE", "SCARY", or "SUS!".
11. "reason" is a brief 1-sentence explanation for the rating.`;

        const imageParts = [{ inlineData: { data: cleanBase64, mimeType: 'image/png' } }];
        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Gemini response did not contain JSON');
        }

        const parsedData = JSON.parse(jsonMatch[0]);

        const appName = parsedData.app_name || 'DoorDash';
        const merchant = (parsedData.merchant || '').toUpperCase();
        const payNum = parseFloat(parsedData.pay || 0);
        const milesNum = parseFloat(parsedData.miles || 0);
        const tipNum = parseFloat(parsedData.tip || 0);
        const rank = (parsedData.rank || 'NONE').toUpperCase();
        const reason = parsedData.reason || '';

        // Clean & Filter Parsed Items Array
        const parsedItems = Array.isArray(parsedData.items)
            ? parsedData.items.map(i => String(i).trim()).filter(Boolean)
            : [];

        // Determine order mode (SHOPPING vs DELIVERING)
        const isShoppingRun = Boolean(
            parsedData.is_shopping || 
            parsedData.is_shop_and_deliver || 
            ['Instacart', 'Shipt'].includes(appName)
        );
        const orderStatus = isShoppingRun ? 'SHOPPING' : 'DELIVERING';

        // IS THIS AN INITIAL OFFER CARD PARSE OR JUST AN ITEMS SCREENSHOT?
        if (payNum > 0 || milesNum > 0) {
            const friction = {
                stops: parseInt(parsedData.stops || 1),
                is_alcohol: Boolean(parsedData.is_alcohol),
                is_shop_and_deliver: Boolean(parsedData.is_shop_and_deliver),
                item_count: parseInt(parsedData.item_count || 0)
            };

            const pay = payNum.toFixed(2);
            const miles = milesNum.toFixed(1);
            const theme = APP_THEMES[appName] || { color: "#FF3008", logoFilename: "dd logo.png" };

            let currentStats = await getShiftStatsFromDropbox();

            let baseGrandTotal = parseFloat(currentStats.grand_total || 0);
            let baseTotalMiles = parseFloat(currentStats.total_miles || 0);

            let existingGrandTotal = await readDropboxFloat('/total.txt', baseGrandTotal);
            let existingTotalMiles = await readDropboxFloat('/miles.txt', baseTotalMiles);

            let newGrandTotal = (existingGrandTotal + payNum).toFixed(2);
            let newTotalMiles = (existingTotalMiles + milesNum).toFixed(1);

            currentStats.grand_total = newGrandTotal;
            currentStats.total_miles = newTotalMiles;
            currentStats.last_offer = {
                appName,
                merchant: merchant || "DELIVERY OFFER",
                pay: `$${pay}`,
                miles,
                rank,
                reason,
                friction,
                orderStatus,
                items: parsedItems,
                themeColor: theme.color,
                logoFilename: theme.logoFilename
            };

            if (tipNum > 0) {
                currentStats.app_tips = (parseFloat(currentStats.app_tips || 0) + tipNum).toFixed(2);
            }

            const offerRecord = {
                id: Date.now(),
                appName,
                merchant: merchant || "DELIVERY OFFER",
                pay: payNum,
                miles: milesNum,
                tip: tipNum,
                rank,
                reason,
                friction,
                orderStatus,
                items: parsedItems,
                timestamp: new Date().toISOString()
            };
            currentStats.offer_history.push(offerRecord);
            currentStats.lastUpdated = new Date().toISOString();

            const itemsPayload = {
                status: orderStatus,
                items: parsedItems
            };

            const currentOfferPayload = {
                pay: `$${pay}`,
                miles: miles,
                merchant: merchant || "DELIVERY OFFER",
                rank: rank,
                reason: reason,
                timestamp: Date.now()
            };

            const filesToUpload = [
                { name: 'current_offer.json', content: JSON.stringify(currentOfferPayload, null, 2) },
                { name: 'total.txt', content: `$${newGrandTotal}` },
                { name: 'miles.txt', content: newTotalMiles },
                { name: 'current_items.json', content: JSON.stringify(itemsPayload, null, 2) },
                { name: 'shift_stats.json', content: JSON.stringify(currentStats, null, 2) }
            ];

            for (const file of filesToUpload) {
                await uploadToDropbox(file.name, file.content);
            }

            await copyDropboxLogo(theme.logoFilename);

            return res.json({
                status: 'success',
                type: 'OFFER_CARD',
                data: { appName, merchant: merchant || "DELIVERY OFFER", pay: `$${pay}`, miles, rank, reason, friction, orderStatus, items: parsedItems, newGrandTotal: `$${newGrandTotal}`, newTotalMiles }
            });
        } 
        else {
            // ITEMS-ONLY SCREENSHOT SAFEGUARD
            let existingItemsObj = await getCurrentItemsFromDropbox();
            let mergedItems = Array.isArray(existingItemsObj.items) ? [...existingItemsObj.items] : [];

            parsedItems.forEach(newItem => {
                const clean = newItem.trim();
                if (clean && !mergedItems.includes(clean)) {
                    mergedItems.push(clean);
                }
            });

            const itemsPayload = {
                status: orderStatus,
                items: mergedItems
            };

            await uploadToDropbox('current_items.json', JSON.stringify(itemsPayload, null, 2));
            console.log(`[Parse Offer] Item screenshot processed safely (${mergedItems.length} items total). Main offer card untouched.`);

            return res.json({
                status: 'success',
                type: 'ITEMS_ONLY',
                data: { orderStatus, items: mergedItems }
            });
        }

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

        const lastOffer = currentStats.offer_history.pop();

        let baseGrandTotal = parseFloat(currentStats.grand_total || 0);
        let baseTotalMiles = parseFloat(currentStats.total_miles || 0);

        let existingGrandTotal = await readDropboxFloat('/total.txt', baseGrandTotal);
        let existingTotalMiles = await readDropboxFloat('/miles.txt', baseTotalMiles);

        let newGrandTotal = Math.max(0, existingGrandTotal - lastOffer.pay).toFixed(2);
        let newTotalMiles = Math.max(0, existingTotalMiles - lastOffer.miles).toFixed(1);

        currentStats.grand_total = newGrandTotal;
        currentStats.total_miles = newTotalMiles;
        if (lastOffer.tip > 0) {
            currentStats.app_tips = Math.max(0, parseFloat(currentStats.app_tips || 0) - lastOffer.tip).toFixed(2);
        }
        currentStats.lastUpdated = new Date().toISOString();

        const emptyItemsObject = {
            status: "DELIVERING",
            items: []
        };

        const emptyOfferObject = {
            pay: "\$0.00",
            miles: "0.0",
            merchant: "[CANCELED]",
            rank: "NONE",
            reason: "",
            timestamp: Date.now()
        };

        const filesToUpload = [
            { name: 'current_offer.json', content: JSON.stringify(emptyOfferObject, null, 2) },
            { name: 'total.txt', content: `$${newGrandTotal}` },
            { name: 'miles.txt', content: newTotalMiles },
            { name: 'current_items.json', content: JSON.stringify(emptyItemsObject, null, 2) },
            { name: 'shift_stats.json', content: JSON.stringify(currentStats, null, 2) }
        ];

        for (const file of filesToUpload) {
            await uploadToDropbox(file.name, file.content);
        }

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
        const { amount } = req.body;
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

        const filesToUpload = [
            { name: 'shift_stats.json', content: JSON.stringify(currentStats, null, 2) }
        ];

        for (const file of filesToUpload) {
            await uploadToDropbox(file.name, file.content);
        }

        res.json({
            status: 'success',
            data: {
                app_tips: updatedAppTips,
                stream_tips: currentStats.stream_tips || "0.00",
                grand_total: `$${updatedGrandTotal}`
            }
        });

    } catch (err) {
        console.error('Add Tip Error:', err.message || err);
        res.status(500).json({ error: 'Failed to record tip' });
    }
});

// =========================================================================
// PAPA GIGS TOTE BOARD API ENDPOINTS
// =========================================================================

// 1. Fetch live tote board stats with CORS & per-app calculation
app.get('/api/toteboard', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

    try {
        let stats = await getShiftStatsFromDropbox();
        
        let appsBreakdown = {
            "DoorDash": 0,
            "Uber Eats": 0,
            "Instacart": 0,
            "Amazon Flex": 0,
            "Shipt": 0,
            "Roadie": 0
        };

        if (Array.isArray(stats.offer_history)) {
            stats.offer_history.forEach(offer => {
                const name = offer.appName || 'Other';
                const pay = parseFloat(offer.pay || 0);
                if (appsBreakdown.hasOwnProperty(name)) {
                    appsBreakdown[name] += pay;
                } else {
                    appsBreakdown[name] = pay;
                }
            });
        }

        res.json({
            gross_earnings: parseFloat(stats.grand_total || 0),
            miles: parseFloat(stats.total_miles || 0),
            app_tips: parseFloat(stats.app_tips || 0),
            other_donations: parseFloat(stats.other_donations || 0),
            superchats: parseFloat(stats.superchats || 0),
            jewels: parseInt(stats.jewels || 0),
            members: parseInt(stats.members || 0),
            subs: parseInt(stats.subs || 0),
            shift_start_subs: stats.shift_start_subs,
            apps_breakdown: appsBreakdown,
            offer_history: stats.offer_history || [],
            last_updated: stats.lastUpdated || new Date().toISOString()
        });
    } catch (err) {
        console.error('Tote board stats fetch error:', err.message || err);
        res.status(500).json({ error: 'Failed to fetch tote board metrics' });
    }
});

// 2. Add manual tips/donations via iOS Shortcut or API
app.post('/api/toteboard/add-donation', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const { type, amount } = req.body;
        const addAmount = parseFloat(amount || 0);

        if (isNaN(addAmount) || addAmount <= 0) {
            return res.status(400).json({ error: 'Invalid donation amount' });
        }

        let currentStats = await getShiftStatsFromDropbox();

        if (type === 'app_tip') {
            currentStats.app_tips = (parseFloat(currentStats.app_tips || 0) + addAmount).toFixed(2);
        } else if (type === 'superchat') {
            currentStats.superchats = (parseFloat(currentStats.superchats || 0) + addAmount).toFixed(2);
            currentStats.grand_total = (parseFloat(currentStats.grand_total || 0) + addAmount).toFixed(2);
        } else if (type === 'jewel') {
            currentStats.jewels = (parseInt(currentStats.jewels || 0) + parseInt(addAmount));
        } else if (type === 'member' || type === 'membership') {
            currentStats.members = (parseInt(currentStats.members || 0) + parseInt(addAmount));
        } else if (type === 'sub' || type === 'subscriber') {
            const currentSubCount = parseInt(currentStats.subs || 0) + parseInt(addAmount);
            currentStats.subs = currentSubCount;

            if (currentStats.shift_start_subs !== undefined && currentStats.shift_start_subs !== null) {
                currentStats.shift_start_subs = parseInt(currentStats.shift_start_subs) - parseInt(addAmount);
            }
        } else {
            currentStats.other_donations = (parseFloat(currentStats.other_donations || 0) + addAmount).toFixed(2);
            currentStats.grand_total = (parseFloat(currentStats.grand_total || 0) + addAmount).toFixed(2);
        }

        currentStats.lastUpdated = new Date().toISOString();

        const filesToUpload = [
            { name: 'shift_stats.json', content: JSON.stringify(currentStats, null, 2) }
        ];

        for (const file of filesToUpload) {
            await uploadToDropbox(file.name, file.content);
        }

        res.json({
            status: 'success',
            data: currentStats
        });
    } catch (err) {
        console.error('Tote board add donation error:', err.message || err);
        res.status(500).json({ error: 'Failed to add donation' });
    }
});

// 3. Reset Tote Board totals ONLY (Keeps Torque vehicle telemetry & trip clock intact!)
app.post('/api/toteboard/reset', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const resetStats = await executeShiftReset();
        console.log('[Tote Board Reset] Cleared shift earnings & offer history (Car telemetry untouched)');
        res.json({ status: 'success', data: resetStats });
    } catch (err) {
        console.error('Tote board reset error:', err.message || err);
        res.status(500).json({ error: 'Failed to reset tote board' });
    }
});

// =========================================================================
// AUTOMATIC SCANNING/CHARGING DATA CLEANUP WATCHER
// =========================================================================
let lastCleanedStatus = "";

async function checkAndCleanScanningStatus() {
    try {
        const fileDownload = await dbx.filesDownload({ path: '/status.txt' });
        let contents = fileDownload.result.fileBinary 
            ? Buffer.from(fileDownload.result.fileBinary).toString('utf-8') 
            : fileDownload.result.fileBinary;
            
        let status = String(contents).trim().toLowerCase();

        // Only clear ONCE when transitioning INTO scanning or charging mode
        if ((status === 'scanning' || status === 'charging') && lastCleanedStatus !== status) {
            lastCleanedStatus = status;

            const emptyItemsObject = {
                status: "DELIVERING",
                items: []
            };

            const emptyOfferObject = {
                pay: "\$0.00",
                miles: "0.0",
                merchant: "READY",
                rank: "NONE",
                reason: "",
                timestamp: Date.now()
            };

            const clearFiles = [
                { name: 'current_offer.json', content: JSON.stringify(emptyOfferObject, null, 2) },
                { name: 'current_items.json', content: JSON.stringify(emptyItemsObject, null, 2) }
            ];

            for (const file of clearFiles) {
                await uploadToDropbox(file.name, file.content);
            }
        } else if (status !== 'scanning' && status !== 'charging') {
            lastCleanedStatus = status;
        }
    } catch (err) {
        // Silent catch if status.txt is momentarily locked or missing
    }
}

// Poll status.txt every 3 seconds to clear old offer data when scanning
setInterval(checkAndCleanScanningStatus, 3000);

// Ensure current_offer.json exists on Dropbox immediately on startup
async function initCurrentOfferJson() {
    try {
        await dbx.filesGetMetadata({ path: '/current_offer.json' });
    } catch (e) {
        console.log('[Startup] /current_offer.json missing on Dropbox, initializing base file...');
        const initialOffer = {
            pay: "\$0.00",
            miles: "0.0",
            merchant: "READY",
            rank: "NONE",
            reason: "",
            timestamp: Date.now()
        };
        await uploadToDropbox('current_offer.json', JSON.stringify(initialOffer, null, 2));
    }
}

// =========================================================================
// SERVER LISTEN
// =========================================================================
const PORT = process.env.PORT || 10000;
http.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await initCurrentOfferJson();
});
