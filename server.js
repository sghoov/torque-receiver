const express = require('express');
const { Dropbox } = require('dropbox');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '20mb' }));

// Initialize Dropbox
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });

// Initialize Gemini SDK using @google/generative-ai
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function uploadToDropbox(filename, content) {
  return dbx.filesUpload({
    path: '/' + filename,
    contents: content,
    mode: { '.tag': 'overwrite' }
  });
}

// =========================================================================
// ROUTE 1: /parse-offer (AI Screenshot Analyzer)
// =========================================================================
app.post('/parse-offer', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided in imageBase64 field' });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // Select Gemini 1.5 Flash Vision Model
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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

    const imageParts = [
      {
        inlineData: {
          data: cleanBase64,
          mimeType: 'image/jpeg'
        }
      }
    ];

    const result = await model.generateContent([prompt, ...imageParts]);
    const responseText = result.response.text();

    // Strip markdown code blocks
    const rawText = responseText.replace(/```json|```/g, '').trim();
    const parsedData = JSON.parse(rawText);

    const appName = parsedData.app_name || 'Gig Offer';
    const merchant = (parsedData.merchant || 'DELIVERY OFFER').toUpperCase();
    const pay = parseFloat(parsedData.pay || 0).toFixed(2);
    const miles = parseFloat(parsedData.miles || 0).toFixed(1);
    const tip = parseFloat(parsedData.tip || 0);

    const uploadPromises = [
      uploadToDropbox('merchant_name.txt', merchant),
      uploadToDropbox('current_offer.txt', `$${pay}`),
      uploadToDropbox('offer_miles.txt', miles)
    ];

    if (tip > 0) {
      let currentStats = { app_tips: "0.00", stream_tips: "0.00", grand_total: "0.00" };
      try {
        const fileDownload = await dbx.filesDownload({ path: '/shift_stats.json' });
        const jsonBuffer = fileDownload.result.fileBinary;
        currentStats = JSON.parse(jsonBuffer.toString('utf8'));
      } catch (e) {
        console.log('shift_stats.json not found, initializing fresh state...');
      }

      const updatedAppTips = (parseFloat(currentStats.app_tips || 0) + tip).toFixed(2);
      const updatedGrandTotal = (parseFloat(currentStats.grand_total || 0) + tip).toFixed(2);

      currentStats.app_tips = updatedAppTips;
      currentStats.grand_total = updatedGrandTotal;
      currentStats.lastUpdated = new Date().toISOString();

      uploadPromises.push(uploadToDropbox('shift_stats.json', JSON.stringify(currentStats, null, 2)));
      uploadPromises.push(uploadToDropbox('doordash_tips.txt', updatedAppTips));
      uploadPromises.push(uploadToDropbox('total.txt', updatedGrandTotal));

      console.log(`[Tip Ingested] +$${tip.toFixed(2)} from ${appName} (${merchant}) | New Total Tips: $${updatedAppTips}`);
    }

    await Promise.all(uploadPromises);

    console.log(`[AI Offer Parsed] App: ${appName} | Store: ${merchant} | Pay: $${pay} | Miles: ${miles} | Tip: $${tip.toFixed(2)}`);

    res.json({
      status: 'success',
      data: { appName, merchant, pay, miles, tip }
    });

  } catch (err) {
    console.error('AI Offer Parsing Error:', err);
    res.status(500).json({ error: 'Failed to parse offer card screenshot with AI' });
  }
});

// =========================================================================
// ROUTE 2: /add-tip
// =========================================================================
app.post('/add-tip', async (req, res) => {
  try {
    const { amount, app_name } = req.body;
    const tipAmount = parseFloat(amount || 0);

    if (isNaN(tipAmount) || tipAmount <= 0) {
      return res.status(400).json({ error: 'Invalid tip amount' });
    }

    let currentStats = { app_tips: "0.00", stream_tips: "0.00", grand_total: "0.00" };
    try {
      const fileDownload = await dbx.filesDownload({ path: '/shift_stats.json' });
      const jsonBuffer = fileDownload.result.fileBinary;
      currentStats = JSON.parse(jsonBuffer.toString('utf8'));
    } catch (e) {
      console.log('shift_stats.json not found, creating new file...');
    }

    const updatedAppTips = (parseFloat(currentStats.app_tips || 0) + tipAmount).toFixed(2);
    const updatedGrandTotal = (parseFloat(currentStats.grand_total || 0) + tipAmount).toFixed(2);

    currentStats.app_tips = updatedAppTips;
    currentStats.grand_total = updatedGrandTotal;
    currentStats.lastUpdated = new Date().toISOString();

    await Promise.all([
      uploadToDropbox('shift_stats.json', JSON.stringify(currentStats, null, 2)),
      uploadToDropbox('doordash_tips.txt', updatedAppTips),
      uploadToDropbox('total.txt', updatedGrandTotal)
    ]);

    console.log(`[Manual Tip Added] +$${tipAmount.toFixed(2)} (${app_name || 'General'}) | Total: $${updatedAppTips}`);

    res.json({
      status: 'success',
      data: {
        app_tips: updatedAppTips,
        stream_tips: currentStats.stream_tips || "0.00",
        grand_total: updatedGrandTotal
      }
    });

  } catch (err) {
    console.error('Add Tip Error:', err);
    res.status(500).json({ error: 'Failed to record tip' });
  }
});

app.get('/', (req, res) => {
  res.send('Torque Receiver API is Live');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
