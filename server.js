// =========================================================================
// AI OFFER CARD PARSER (/parse-offer) - DIRECT GEMINI RANKING & REASON
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

        const prompt = 
            'Analyze this gig delivery offer card or order details screenshot from one of these platforms: ' +
            'DoorDash, Uber Eats, Instacart, Amazon Flex, Shipt, or Roadie.\n\n' +

            'This screenshot could be EITHER:\n' +
            'A) An initial offer acceptance card (showing payout price, distance miles, and merchant).\n' +
            'B) An order items / itemized shopping list screen (showing food/grocery items).\n\n' +

            'Extract the details and evaluate the offer quality using the ranking rules below.\n\n' +

            '### RANKING RULES:\n\n' +

            '1. STANDARD DELIVERY RUNS (Restaurants / Fast Food / Package Pickups):\n' +
            '   - "BANGER!": High payout (over \$16), high rate per mile (\$2.00+/mile), short time commitment, or great overall offer value.\n' +
            '   - "SOLID": Fair payout (\$1.50 - \$2.00/mile), reliable merchant, reasonable distance.\n' +
            '   - "MEH": Borderline payout (\$1.00 - \$1.50/mile), average offer, or multiple stops.\n' +
            '   - "DESPERATE": Low payout (<\$1.00/mile), long distance, high effort, 3+ stops, or terrible pay for distance. (Can also use spooky terms like "SCARY" or "GHOST TOWN" with attitude!)\n' +
            '   - "SUS!": Red flags present (e.g. unrealistically high pay for short miles, over \$3.00/mile, suspicious store/distance ratio, or "too good to be true").\n\n' +

            '2. SHOP & DELIVER ORDERS (Instacart, Shipt, DoorDash/Uber Shop Runs):\n' +
            '   - LARGE SHOPS (15+ Items):\n' +
            '     * BASE REQUIREMENT: Must meet a minimum of \$1.00 per item + \$1.00 per mile.\n' +
            '     * "BANGER!" / "SOLID": Meets or exceeds \$1.00/item + \$1.00/mile AND offers great overall time/value.\n' +
            '     * "MEH" / "DESPERATE": Total pay drops below \$1.00/item + \$1.00/mile, or high item count (30+) with low pay per item.\n' +
            '   - SMALL SHOPS (< 15 Items):\n' +
            '     * BASE REQUIREMENT: Focus heavily on Pay-per-Mile (\$1.50-\$2.00+/mile) AND must meet at least \$1.25 per item.\n' +
            '     * "BANGER!" / "SOLID": High pay-per-mile ratio (e.g. \$15 for 3 miles and 5 items).\n' +
            '     * "MEH" / "DESPERATE": Pay per item is under \$1.25/item or low mileage pay.\n' +
            '   - "SUS!": Abnormally low pay for high effort (e.g. \$7 for 15 items and 8 miles) OR suspicious/unrealistic payouts.\n\n' +

            '---\n\n' +

            'Extract the details and return ONLY a valid JSON object with no markdown formatting:\n' +
            '{\n' +
            '  "app_name": "DoorDash | Uber Eats | Instacart | Amazon Flex | Shipt | Roadie",\n' +
            '  "merchant": "Store or Restaurant Name",\n' +
            '  "pay": 0.00,\n' +
            '  "miles": 0.0,\n' +
            '  "tip": 0.00,\n' +
            '  "stops": 1,\n' +
            '  "is_alcohol": false,\n' +
            '  "is_shop_and_deliver": false,\n' +
            '  "is_shopping": false,\n' +
            '  "item_count": 0,\n' +
            '  "items": [],\n' +
            '  "rank": "BANGER! | SOLID | MEH | DESPERATE | SCARY | SUS!",\n' +
            '  "reason": "Max 5 word funny/punchy sentence with attitude explaining WHY you chose this rank."\n' +
            '}\n\n' +

            'Rules:\n' +
            '1. "pay" is the total earnings payout shown on an offer card. If no dollar payout is visible on this screen, set "pay" to 0.00.\n' +
            '2. "miles" is the distance in miles shown on an offer card. If no distance is visible on this screen, set "miles" to 0.0.\n' +
            '3. "merchant" is the pickup store/restaurant. If unknown, set to "".\n' +
            '4. "stops" is the number of pickups + dropoffs / order stops.\n' +
            '5. "is_alcohol" is true if the offer mentions alcohol, wine, beer, restricted items, or ID verification required.\n' +
            '6. "is_shop_and_deliver" is true if it requires red card shopping, grocery picking, shop & deliver, or Instacart/Shipt shopping.\n' +
            '7. "is_shopping" is true if this is an Instacart or Shipt order, OR if it\'s a grocery/retail/store Shop & Deliver run.\n' +
            '8. "item_count" is the total number of items or units shown if it is a shop & deliver or grocery order.\n' +
            '9. "items" is an array of strings containing ONLY the primary food menu items or grocery items with quantities.\n' +
            '10. "rank" MUST be determined using the RANKING RULES above.\n' +
            '11. "reason" MUST be a single punchy, funny, witty MAX 5-WORD sentence directly explaining why your assigned "rank" fits this payout. Use abbreviations and numbers to keep character count extremely low.';

        const imageParts = [{ inlineData: { data: cleanBase64, mimeType: 'image/png' } }];
        const result = await model.generateContent([prompt, ...imageParts]);
        const responseText = result.response.text();

        console.log('[Gemini Raw Response]:', responseText);

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

        const aiRank = (parsedData.rank || 'MEH').toUpperCase();
        const reason = parsedData.reason || `Ranked ${aiRank} by AI offer parser.`;

        const parsedItems = Array.isArray(parsedData.items)
            ? parsedData.items.map(i => String(i).trim()).filter(Boolean)
            : [];

        const isShoppingRun = Boolean(
            parsedData.is_shopping || 
            parsedData.is_shop_and_deliver || 
            ['Instacart', 'Shipt'].includes(appName)
        );
        const orderStatus = isShoppingRun ? 'SHOPPING' : 'DELIVERING';

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
                rank: aiRank,
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
                rank: aiRank,
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
                rank: aiRank,
                reason: reason,
                timestamp: Date.now()
            };

            const filesToUpload = [
                { name: 'current_offer.txt', content: `$${pay}` },
                { name: 'offer_miles.txt', content: miles },
                { name: 'merchant_name.txt', content: merchant || "DELIVERY OFFER" },
                { name: 'offer_rank.txt', content: aiRank },
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
                data: { appName, merchant: merchant || "DELIVERY OFFER", pay: `$${pay}`, miles, rank: aiRank, reason, friction, orderStatus, items: parsedItems, newGrandTotal: `$${newGrandTotal}`, newTotalMiles }
            });
        } 
        else {
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
