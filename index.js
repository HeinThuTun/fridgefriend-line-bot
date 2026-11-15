require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenAI } = require('@google/genai');

const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN?.trim(),
  channelSecret: process.env.CHANNEL_SECRET?.trim(),
};

const messagingClient = new line.messagingApi.MessagingApiClient(lineConfig);
const blobClient = new line.messagingApi.MessagingApiBlobClient(lineConfig);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY?.trim() });

const app = express();
const DB_FILE = path.join(__dirname, 'db.json');
const recipeStore = new Map();
const mealPlanStore = new Map();
const pendingReceiptItems = new Map();
const generatedImageCache = new Map(); // Stores exact dish JPEG/PNG buffers for LINE Flex cards
let cachedModels = null;
let cachedImageModel = null;

// --- Multi-User Persistence + Full 5-Stream B2B Analytics (db.json) ---
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!parsed.analytics) parsed.analytics = {};
      parsed.analytics = {
        sponsoredClicks: 0,
        affiliateClicks: 0,
        couponClaims: 0,
        gymActivations: 0,
        ingredientCounts: {},
        missingCounts: {},
        ...parsed.analytics,
      };
      return parsed;
    }
  } catch (e) {
    console.warn('⚠️ Failed to read db.json, starting fresh:', e.message);
  }
  return {
    users: {},
    analytics: {
      sponsoredClicks: 0,
      affiliateClicks: 0,
      couponClaims: 0,
      gymActivations: 0,
      ingredientCounts: {},
      missingCounts: {},
    },
  };
}

const db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Failed to write db.json:', e.message);
  }
}

function getTodayKey() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getSession(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      lastPromptType: null,
      lastText: '',
      lastImageBase64: null,
      saved: [],
      gymPartner: null,
      goals: { calories: 2000, protein: 130, label: 'Balanced (2000 kcal)' },
      logs: {},
    };
    saveDB();
  }
  const user = db.users[userId];
  if (!user.goals) user.goals = { calories: 2000, protein: 130, label: 'Balanced (2000 kcal)' };
  if (!Array.isArray(user.saved)) user.saved = [];
  const today = getTodayKey();
  if (!user.logs[today]) user.logs[today] = { calories: 0, protein: 0, meals: [] };
  return user;
}

// --- Stream 4: Verified B2B Partner Invite Codes (Issued by Paying Gyms/Clinics) ---
const B2B_PARTNER_CODES = {
  FITFIRST26: { partner: 'Fitness First Thailand', calories: 2400, protein: 165 },
  JETTS2026: { partner: 'Jetts 24 Hour Fitness', calories: 2300, protein: 155 },
  TUGYM99: { partner: 'TU Rangsit Sports Complex', calories: 2200, protein: 150 },
};

// --- Stream 5 Helper: Record Anonymized FMCG Pantry & Missing Item Trends ---
function recordPantryTrends(rawIngredientsText = '', missingItemsList = []) {
  if (rawIngredientsText) {
    const items = rawIngredientsText
      .split(/[,;\n၊]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2 && s.length <= 35);
    for (const item of items) {
      db.analytics.ingredientCounts[item] = (db.analytics.ingredientCounts[item] || 0) + 1;
    }
  }
  if (Array.isArray(missingItemsList)) {
    for (const raw of missingItemsList) {
      if (!raw || raw.startsWith('None')) continue;
      const clean = raw
        .replace(/^[\d./]+\s*(?:tbsp|tsp|cup|cups|g|kg|ml|l|pcs|cloves|bunch|bottle)?\s*/i, '')
        .trim()
        .toLowerCase();
      if (clean.length >= 2) {
        db.analytics.missingCounts[clean] = (db.analytics.missingCounts[clean] || 0) + 1;
      }
    }
  }
  saveDB();
}

// --- Stream 2: Multi-Partner Contextual Ad Pool (Deduplicated Across Cards) ---
const PARTNER_AD_POOL = [
  {
    tags: ['protein', 'chicken', 'egg', 'beef', 'pork', 'salmon', 'fitness'],
    sponsor: 'Meiji High Protein (7-Eleven)',
    tagline: '⚡ Boost +28g Protein: Pair with Meiji High Protein Milk',
    promoCode: 'FFMEIJI10 (10 THB Off at 7-Eleven)',
    url: 'https://www.7eleven.co.th/',
  },
  {
    tags: ['chicken', 'meat', 'budget', 'pork', 'fresh'],
    sponsor: 'CP FreshMart / Lotus’s Go Fresh',
    tagline: '🏷️ Zero-Waste Deal: 25% Off Fresh Chicken Breast Packs',
    promoCode: 'FFCP25 (Show Barcode at Checkout)',
    url: 'https://www.lotuss.com/th',
  },
  {
    tags: ['thai', 'basil', 'garlic', 'soy', 'stir', 'oyster'],
    sponsor: 'Healthy Boy Brand (เด็กสมบูรณ์)',
    tagline: '🌟 Chef Pick: Healthy Boy Oyster & Soy Sauce Combo',
    promoCode: 'FFTHAI15 (15% Off on Shopee Mall)',
    url: 'https://shopee.co.th/search?keyword=healthy%20boy%20oyster%20sauce',
  },
  {
    tags: ['rice', 'noodle', 'quick', 'fry', 'spicy', 'chili'],
    sponsor: 'Maggi Thailand (แม็กกี้)',
    tagline: '🔥 1-Drop Umami: Maggi Cooking Sauce Value Pack',
    promoCode: 'FFMAGGI20 (20 THB Off at Tops)',
    url: 'https://www.tops.co.th/en/search/maggi',
  },
  {
    tags: ['egg', 'omelette', 'tomato', 'fried', 'kid', 'quick'],
    sponsor: 'Roza Lycopene (โรซ่า)',
    tagline: '🍅 Zero-Sugar Tomato & Chili Sauce for Quick Meals',
    promoCode: 'FFROZA10 (Buy 1 Get 1 Mini Pack)',
    url: 'https://www.tops.co.th/en/search/roza',
  },
  {
    tags: ['salad', 'veggie', 'tofu', 'healthy', 'diet', 'low'],
    sponsor: 'Kewpie Thailand (คิวพี)',
    tagline: '🥗 Roasted Sesame Dressing — Light & High Flavor',
    promoCode: 'FFKEWPIE15 (15% Off on Lazada)',
    url: 'https://www.lazada.co.th/catalog/?q=kewpie+sesame',
  },
  {
    tags: ['pasta', 'milk', 'cheese', 'butter', 'cream'],
    sponsor: 'Tops Online Express',
    tagline: '🚚 Missing Dairy or Pasta? 1-Hour Delivery to Dorm',
    promoCode: 'FFTOPS50 (50 THB Off First Order)',
    url: 'https://www.tops.co.th/en/',
  },
  {
    tags: ['all', 'student', 'budget', 'grocery'],
    sponsor: 'GrabMart Student Saver',
    tagline: '🛵 Free Delivery on Missing Ingredients Under 150 THB',
    promoCode: 'FFGRABFREE (Free Delivery Near Campus)',
    url: 'https://food.grab.com/th/en/',
  },
  {
    tags: ['bulk', 'meal', 'prep', 'plan', '3-day'],
    sponsor: 'Makro PRO (แม็คโคร โปร)',
    tagline: '📦 Meal-Prep Saver: Bulk Eggs & Chicken Packs',
    promoCode: 'FFMAKRO40 (40 THB Off App Order)',
    url: 'https://www.makro.pro/',
  },
];

function getContextualSponsor(contextText = '', filterStyle = '', usedSponsors = new Set()) {
  const lower = `${contextText} ${filterStyle}`.toLowerCase();
  const available = PARTNER_AD_POOL.filter((ad) => !usedSponsors.has(ad.sponsor));
  const pool = available.length > 0 ? available : PARTNER_AD_POOL;

  const scored = pool.map((ad) => {
    const score = ad.tags.reduce((acc, tag) => (lower.includes(tag) ? acc + 2 : acc), 0);
    return { ad, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0].ad;
  usedSponsors.add(chosen.sponsor);
  return chosen;
}

// --- Pure Node.js PNG Generator with Icons + Bold Labels ---
function createRichMenuPngBuffer() {
  const width = 2500;
  const height = 843;
  const tileColors = [[6, 95, 70], [4, 120, 87], [5, 150, 105], [16, 185, 129]];
  const FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };
  const ICONS = [
    ['000011110000','000111111000','111111111111','111100001111','111001100111','111011110111','111011110111','111001100111','111100001111','111111111111','111111111111','000000000000'],
    ['001100001100','111111111111','111111111111','110000000011','110110011011','110110011011','110000000011','110110011011','110110011011','110000000011','111111111111','000000000000'],
    ['011111111100','011000000110','011011011010','011111111010','011111111010','011011110010','011001100010','011000000010','011000000010','011111111110','001111111100','000000000000'],
    ['000000000110','000000000110','000001100110','000001100110','000001100110','011001100110','011001100110','011001100110','011001100110','111111111111','111111111111','000000000000'],
  ];
  const LABELS = [['SCAN', 'FRIDGE'], ['3-DAY', 'PLAN'], ['MY', 'COOKBOOK'], ['DAILY', 'MACROS']];

  const rowSize = 1 + width * 3;
  const rawImageData = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawImageData[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const tileIdx = Math.min(Math.floor(x / 625), 3);
      const isDivider = x > 0 && x % 625 < 6;
      const [r, g, b] = isDivider ? [255, 255, 255] : tileColors[tileIdx];
      const px = rowOffset + 1 + x * 3;
      rawImageData[px] = r; rawImageData[px + 1] = g; rawImageData[px + 2] = b;
    }
  }

  function fillRect(x0, y0, w, h, r, g, b) {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      const rowOffset = y * rowSize;
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const px = rowOffset + 1 + x * 3;
        rawImageData[px] = r; rawImageData[px + 1] = g; rawImageData[px + 2] = b;
      }
    }
  }

  function drawText(text, centerX, startY, scale) {
    const charW = 5 * scale;
    const gap = 2 * scale;
    let cursorX = Math.round(centerX - (text.length * charW + (text.length - 1) * gap) / 2);
    for (const ch of text) {
      const glyph = FONT[ch] || FONT[' '];
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] === '1') fillRect(cursorX + gx * scale, startY + gy * scale, scale, scale, 255, 255, 255);
        }
      }
      cursorX += charW + gap;
    }
  }

  for (let t = 0; t < 4; t++) {
    const centerX = t * 625 + 312;
    const iconScale = 16;
    const iconStartX = centerX - (12 * iconScale) / 2;
    for (let iy = 0; iy < 12; iy++) {
      for (let ix = 0; ix < 12; ix++) {
        if (ICONS[t][iy][ix] === '1') fillRect(iconStartX + ix * iconScale, 170 + iy * iconScale, iconScale, iconScale, 255, 255, 255);
      }
    }
    drawText(LABELS[t][0], centerX, 430, 10);
    drawText(LABELS[t][1], centerX, 535, 10);
  }

  const compressed = zlib.deflateSync(rawImageData);
  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    const crcInput = Buffer.concat([typeBuf, data]);
    let crc = 0xffffffff;
    for (let i = 0; i < crcInput.length; i++) {
      crc ^= crcInput[i];
      for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
}

async function setupRichMenu() {
  try {
    const existing = await messagingClient.getRichMenuList();
    for (const m of existing.richmenus || []) await messagingClient.deleteRichMenu(m.richMenuId).catch(() => {});

    const richMenuRes = await messagingClient.createRichMenu({
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'FridgeFriend_Pro_Menu_v13',
      chatBarText: '🍳 Chef Menu',
      areas: [
        { bounds: { x: 0, y: 0, width: 625, height: 843 }, action: { type: 'uri', label: 'Scan Fridge', uri: 'https://line.me/R/nv/camera/' } },
        { bounds: { x: 625, y: 0, width: 625, height: 843 }, action: { type: 'postback', label: '3-Day Plan', data: 'action=meal_plan', displayText: '🗓️ Generate 3-Day Zero-Waste Meal Plan' } },
        { bounds: { x: 1250, y: 0, width: 625, height: 843 }, action: { type: 'message', label: 'My Cookbook', text: 'saved' } },
        { bounds: { x: 1875, y: 0, width: 625, height: 843 }, action: { type: 'message', label: 'Daily Macros', text: 'stats' } },
      ],
    });

    const richMenuId = richMenuRes.richMenuId;
    const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lineConfig.channelAccessToken}`, 'Content-Type': 'image/png' },
      body: createRichMenuPngBuffer(),
    });
    if (!uploadRes.ok) throw new Error(`Image upload failed (${uploadRes.status}): ${await uploadRes.text()}`);

    await messagingClient.setDefaultRichMenu(richMenuId);
    console.log('✅ Deployed Native Bottom Rich Menu:', richMenuId);
  } catch (e) {
    console.warn('⚠️ Rich Menu setup skipped:', e?.message || e);
  }
}

app.get('/', (req, res) => res.send('FridgeFriend Pro LINE Bot is running!'));

// --- Serve Exact Generated Dish Photos Directly to LINE Flex Cards ---
app.get('/dish-img/:id', (req, res) => {
  const key = req.params.id.replace(/\.(jpg|jpeg|png)$/i, '');
  const entry = generatedImageCache.get(key);
  if (!entry) return res.status(404).send('Image not found');
  res.setHeader('Content-Type', entry.mimeType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(entry.buffer);
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  console.log('📩 Webhook hit! Events:', req.body.events.length);
  res.status(200).end();
  req.body.events.forEach((event) => {
    handleEvent(event).catch((err) => console.error('❌ Error:', err?.status, err?.message, JSON.stringify(err?.errors || err?.body || '')));
  });
});

async function getMessageBase64(messageId) {
  const stream = await blobClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('base64');
}

// --- Discover Available Gemini Image Model Dynamically ---
async function getImageCapableModel() {
  if (cachedImageModel) return cachedImageModel;
  try {
    const pager = await ai.models.list();
    const candidates = [];
    for await (const m of pager) {
      const name = m.name.replace('models/', '');
      if (name.includes('image') || name.includes('imagen')) candidates.push(name);
    }
    const preferred = candidates.find((n) => n.includes('gemini-2.5-flash-image'))
      || candidates.find((n) => n.includes('flash-image'))
      || candidates.find((n) => n.includes('imagen'))
      || candidates[0];
    if (preferred) {
      cachedImageModel = preferred;
      console.log('🎨 Discovered image model:', cachedImageModel);
      return cachedImageModel;
    }
  } catch (e) {
    console.warn('⚠️ Image model discovery failed:', e.message);
  }
  return 'gemini-2.5-flash-image';
}

// --- 100% Exact Dish Photo Generator Using Your Own Gemini API Key ---
async function getRecipeImageUrl(recipe, usedUrls = new Set(), publicBaseUrl = '') {
  const dishDesc = (recipe.canonicalDish || recipe.title || 'homemade stir fry dish').trim();
  const baseUrl = (process.env.RENDER_EXTERNAL_URL || publicBaseUrl || '').replace(/\/$/, '');

  // 1. Primary: Generate Exact Custom Dish Photo via Gemini Image Generation & Serve from Render
  if (baseUrl) {
    try {
      const imgModel = await getImageCapableModel();
      const prompt = `Appetizing overhead food photography of ${dishDesc}, freshly cooked and plated on a clean ceramic dish on a wooden table, warm natural daylight, sharp focus, realistic restaurant presentation, no text, no labels, no watermark.`;

      let base64Data = null;
      let mimeType = 'image/jpeg';

      if (imgModel.includes('imagen')) {
        const res = await ai.models.generateImages({
          model: imgModel,
          prompt,
          config: { numberOfImages: 1, aspectRatio: '16:9', outputMimeType: 'image/jpeg' },
        });
        base64Data = res?.generatedImages?.[0]?.image?.imageBytes;
      } else {
        const res = await ai.models.generateContent({
          model: imgModel,
          contents: prompt,
          config: { responseModalities: ['IMAGE'] },
        });
        const parts = res?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find((p) => p?.inlineData?.data);
        if (imgPart) {
          base64Data = imgPart.inlineData.data;
          mimeType = imgPart.inlineData.mimeType || 'image/jpeg';
        }
      }

      if (base64Data) {
        const imgId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        generatedImageCache.set(imgId, { buffer: Buffer.from(base64Data, 'base64'), mimeType });
        if (generatedImageCache.size > 60) {
          const oldestKey = generatedImageCache.keys().next().value;
          generatedImageCache.delete(oldestKey);
        }
        const servedUrl = `${baseUrl}/dish-img/${imgId}.jpg`;
        console.log(`🎨 Generated exact dish image for "${dishDesc}":`, servedUrl);
        usedUrls.add(servedUrl);
        return servedUrl;
      }
    } catch (e) {
      console.warn(`⚠️ Gemini image gen fallback for "${dishDesc}":`, e.message);
    }
  }

  // 2. Fallback: Exact Dish Name Search in TheMealDB (Only Exact Dish Matches — Never Generic Ingredient Desserts!)
  for (const query of [recipe.canonicalDish, recipe.title].filter(Boolean)) {
    try {
      const res = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        const hit = (data.meals || []).find((m) => m?.strMealThumb && !usedUrls.has(m.strMealThumb));
        if (hit) {
          usedUrls.add(hit.strMealThumb);
          return hit.strMealThumb;
        }
      }
    } catch {}
  }

  // 3. Final Verified Savory Dish Fallbacks (Guaranteed Real Savory Meals, Never Cakes!)
  const savoryFallbacks = [
    'https://www.themealdb.com/images/media/meals/wvpsxx1468256321.jpg',
    'https://www.themealdb.com/images/media/meals/1550441882.jpg',
    'https://www.themealdb.com/images/media/meals/1529444830.jpg',
  ];
  const pick = savoryFallbacks.find((u) => !usedUrls.has(u)) || savoryFallbacks[0];
  usedUrls.add(pick);
  return pick;
}

async function getAvailableModels() {
  if (cachedModels) return cachedModels;
  try {
    const pager = await ai.models.list();
    const found = [];
    for await (const m of pager) {
      const name = m.name.replace('models/', '');
      if ((name.includes('flash') || name.includes('gemma')) && !name.includes('image') && !name.includes('audio') && !name.includes('tts') && !name.includes('embedding')) {
        found.push(name);
      }
    }
    found.sort((a, b) => (a.includes('lite') ? -1 : 1));
    if (found.length > 0) { cachedModels = found; console.log('📋 Discovered models:', cachedModels); return cachedModels; }
  } catch (e) {
    console.warn('⚠️ Could not list models:', e.message);
  }
  return ['gemini-2.5-flash'];
}

async function generateWithFallback(contents, config) {
  const models = await getAvailableModels();
  try {
    const res = await Promise.any(models.slice(0, 3).map(async (model) => {
      const out = await ai.models.generateContent({ model, contents, config });
      console.log(`✅ Parallel winner: ${model}`);
      return out;
    }));
    return res;
  } catch {
    console.warn('⚠️ Parallel burst hit limit, retrying sequentially...');
  }

  let lastErr;
  for (const model of models) {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const res = await ai.models.generateContent({ model, contents, config });
      console.log(`✅ Fallback winner: ${model}`);
      return res;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// --- Flex UI Builders ---
function buildWelcomeCard() {
  return {
    type: 'flex',
    altText: '👋 Welcome to FridgeFriend AI Chef!',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#065F46',
        contents: [
          { type: 'text', text: '🍳 FRIDGEFRIEND AI', color: '#A7F3D0', size: 'xs', weight: 'bold' },
          { type: 'text', text: 'Your Smart Kitchen & Macro Chef', color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: 'Try any input mode (English / ไทย / မြန်မာ):', size: 'sm', weight: 'bold', color: '#111827', wrap: true },
          { type: 'text', text: '📸 Snap a fridge photo or grocery receipt', size: 'xs', color: '#374151', wrap: true },
          { type: 'text', text: '🎙️ Hold the mic & speak in English, Thai, or Burmese', size: 'xs', color: '#374151', wrap: true },
          { type: 'text', text: '✍️ Type ingredients in any language (e.g. "chicken, garlic", "อกไก่ กระเทียม", "ကြက်သား ကြက်သွန်ဖြူ")', size: 'xs', color: '#374151', wrap: true },
          { type: 'text', text: '🏷️ Claim 30% Off Zero-Waste Supermarket Flash Deals', size: 'xs', color: '#374151', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'message', label: '🍗 Try Demo: Chicken & Garlic', text: 'chicken breast, garlic' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🏷️ Tonight’s 30% Off Flash Deal', data: 'action=flash_deal', displayText: '🏷️ Claim Zero-Waste Flash Deal' } },
        ],
      },
    },
  };
}

function getFilterQuickReplies() {
  return {
    items: [
      { type: 'action', action: { type: 'postback', label: '🏷️ 30% Flash Deal', data: 'action=flash_deal', displayText: '🏷️ Tonight’s Zero-Waste Flash Deal' } },
      { type: 'action', action: { type: 'postback', label: '💰 Under 60 THB', data: 'action=filter&style=budget_60', displayText: '💰 Budget meals under 60 THB' } },
      { type: 'action', action: { type: 'postback', label: '🗓️ 3-Day Plan', data: 'action=meal_plan', displayText: '🗓️ 3-Day Zero-Waste Meal Plan' } },
      { type: 'action', action: { type: 'postback', label: '💪 High Protein', data: 'action=filter&style=high_protein', displayText: '💪 High Protein options' } },
      { type: 'action', action: { type: 'postback', label: '🌶️ Thai Style', data: 'action=filter&style=thai_style', displayText: '🌶️ Thai Style options' } },
      { type: 'action', action: { type: 'message', label: '💼 B2B Revenue', text: 'revenue' } },
    ],
  };
}

// --- Clean Executive Flex Card for 5-Stream B2B Business Model & Live Metrics ---
function buildB2BRevenueCard() {
  const totalUsers = Object.keys(db.users || {}).length;
  const affViews = db.analytics.affiliateClicks || 0;
  const adClicks = db.analytics.sponsoredClicks || 0;
  const coupons = db.analytics.couponClaims || 0;
  const gymSeats = db.analytics.gymActivations || 0;

  const estThb = affViews * 15 + adClicks * 5 + coupons * 20 + gymSeats * 80;

  const topPantry = Object.entries(db.analytics.ingredientCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ') || 'chicken, garlic, eggs';

  const topMissing = Object.entries(db.analytics.missingCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ') || 'soy sauce, oyster sauce, rice';

  return {
    type: 'flex',
    altText: '💼 FridgeFriend B2B Business & Revenue Dashboard',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1E293B',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '💼 B2B MONETIZATION ENGINE', color: '#38BDF8', size: 'xs', weight: 'bold' },
          { type: 'text', text: 'FridgeFriend Revenue & Data', color: '#FFFFFF', size: 'lg', weight: 'bold' },
          { type: 'text', text: '100% Free for Users • Monetized via B2B Partners', color: '#CBD5E1', size: 'xs', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#ECFDF5',
            cornerRadius: 'md',
            paddingAll: 'md',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  { type: 'text', text: 'ACTIVE USERS', size: 'xxs', color: '#065F46', weight: 'bold' },
                  { type: 'text', text: `${totalUsers}`, size: 'xl', color: '#047857', weight: 'bold' },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  { type: 'text', text: 'EST. B2B VALUE', size: 'xxs', color: '#065F46', weight: 'bold' },
                  { type: 'text', text: `${estThb} THB`, size: 'xl', color: '#047857', weight: 'bold' },
                ],
              },
            ],
          },
          { type: 'text', text: '5 ACTIVE B2B REVENUE STREAMS', size: 'xs', weight: 'bold', color: '#475569' },

          // Stream 1
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '1. Grocery Delivery Affiliate', size: 'xs', weight: 'bold', color: '#0F172A', flex: 4 },
                  { type: 'text', text: `${affViews} carts`, size: 'xs', weight: 'bold', color: '#059669', align: 'end', flex: 2 },
                ],
              },
              { type: 'text', text: 'Earns 5–8% commission when users order missing items via GrabMart or Tops.', size: 'xxs', color: '#64748B', wrap: true },
            ],
          },
          { type: 'separator' },

          // Stream 2
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '2. Contextual Native Brand Ads', size: 'xs', weight: 'bold', color: '#0F172A', flex: 4 },
                  { type: 'text', text: `${adClicks} clicks`, size: 'xs', weight: 'bold', color: '#D97706', align: 'end', flex: 2 },
                ],
              },
              { type: 'text', text: 'Brands (Meiji, Healthy Boy) pay CPC fees to match ingredients with dishes.', size: 'xxs', color: '#64748B', wrap: true },
            ],
          },
          { type: 'separator' },

          // Stream 3
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '3. Zero-Waste Flash Coupons', size: 'xs', weight: 'bold', color: '#0F172A', flex: 4 },
                  { type: 'text', text: `${coupons} claims`, size: 'xs', weight: 'bold', color: '#DC2626', align: 'end', flex: 2 },
                ],
              },
              { type: 'text', text: 'Supermarkets pay 20 THB CPA per redeemed near-expiry discount barcode.', size: 'xxs', color: '#64748B', wrap: true },
            ],
          },
          { type: 'separator' },

          // Stream 4
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '4. B2B Gym & Clinic Licensing', size: 'xs', weight: 'bold', color: '#0F172A', flex: 4 },
                  { type: 'text', text: `${gymSeats} seats`, size: 'xs', weight: 'bold', color: '#2563EB', align: 'end', flex: 2 },
                ],
              },
              { type: 'text', text: 'Gyms pay 80 THB/member/mo & issue invite codes (e.g., redeem FITFIRST26).', size: 'xxs', color: '#64748B', wrap: true },
            ],
          },
          { type: 'separator' },

          // Stream 5
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F8FAFC',
            cornerRadius: 'md',
            paddingAll: 'sm',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '5. FMCG Pantry Trend Data (B2B SaaS)', size: 'xs', weight: 'bold', color: '#0F172A' },
              { type: 'text', text: 'Anonymized household demand reports sold to food brands:', size: 'xxs', color: '#64748B', wrap: true },
              { type: 'text', text: `🥬 Top In-Fridge: ${topPantry}`, size: 'xxs', color: '#047857', weight: 'bold', wrap: true },
              { type: 'text', text: `🛒 Top Missing: ${topMissing}`, size: 'xxs', color: '#B91C1C', weight: 'bold', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0F172A',
            height: 'sm',
            action: { type: 'message', label: '🔄 Refresh Live Dashboard', text: 'revenue' },
          },
        ],
      },
    },
    quickReply: getFilterQuickReplies(),
  };
}

// --- Stream 3: Zero-Waste Supermarket Flash Deal Coupon Card ---
function buildFlashDealCard() {
  const code = `FF-LOTUS-${Math.floor(1000 + Math.random() * 9000)}`;
  return {
    type: 'flex',
    altText: '🏷️ Zero-Waste Supermarket Flash Deal!',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#B45309',
        contents: [
          { type: 'text', text: '♻️ ZERO-WASTE EVENING CLEARANCE', color: '#FDE68A', size: 'xs', weight: 'bold' },
          { type: 'text', text: '30% OFF Fresh Chicken & Greens', color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: "📍 Partner Store: Lotus's Go Fresh (Rangsit / TU Dome)", size: 'xs', color: '#374151', wrap: true },
          { type: 'text', text: '⏰ Valid Today: 18:00 – 21:30 (Prevent Food Waste)', size: 'xs', color: '#374151', wrap: true },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FEF3C7',
            cornerRadius: 'md',
            paddingAll: 'md',
            margin: 'md',
            contents: [
              { type: 'text', text: 'CASHIER BARCODE VOUCHER', size: 'xxs', color: '#92400E', align: 'center', weight: 'bold' },
              { type: 'text', text: code, size: 'xl', color: '#78350F', align: 'center', weight: 'bold' },
            ],
          },
          { type: 'text', text: '💼 B2B Model: Supermarket pays 20 THB CPA per redeemed coupon.', size: 'xxs', color: '#6B7280', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', color: '#D97706', height: 'sm', action: { type: 'uri', label: '📍 Open Nearest Partner Store', uri: 'https://www.google.com/maps/search/Lotus+Go+Fresh+near+me' } },
        ],
      },
    },
  };
}

async function buildRecipeCarousel(recipes, includeQuickReplies = true, filterStyle = '', publicBaseUrl = '') {
  const safeRecipes = Array.isArray(recipes) && recipes.length > 0
    ? recipes.slice(0, 5)
    : [{
        title: 'Quick Garlic Chicken Stir-Fry',
        emoji: '🍳',
        canonicalDish: 'Thai Garlic Chicken Stir Fry with Jasmine Rice',
        mainIngredient: 'chicken',
        calories: 460,
        protein: 38,
        costThb: 45,
        time: '15m total',
        allIngredients: ['200g chicken breast', '2 cloves garlic', '1 tbsp soy sauce', '1 tbsp cooking oil', '1 cup steamed rice'],
        missingItems: ['1 tbsp soy sauce', '1 tbsp cooking oil', '1 cup steamed rice'],
        steps: ['Slice chicken and mince garlic.', 'Stir-fry over medium-high heat for 8 minutes.', 'Season with soy sauce and serve hot over rice!'],
      }];

  const usedUrls = new Set();
  const usedSponsors = new Set();
  const prepared = [];

  for (let idx = 0; idx < safeRecipes.length; idx++) {
    const recipe = safeRecipes[idx];
    const recipeId = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1000)}`;
    const title = (recipe.title || 'Quick Fridge Dish').slice(0, 60);
    const time = recipe.time || '15m total';
    const calories = Number(recipe.calories) || 450;
    const protein = Number(recipe.protein) || 32;
    const costThb = Number(recipe.costThb) || 45;
    const macros = `${calories} kcal | ${protein}g P | ~${costThb} THB`;
    const allIngredients = Array.isArray(recipe.allIngredients) ? recipe.allIngredients : [];
    const missing = Array.isArray(recipe.missingItems) && recipe.missingItems.length > 0 ? recipe.missingItems : ['None — ready to cook!'];
    const steps = Array.isArray(recipe.steps) && recipe.steps.length > 0 ? recipe.steps : ['Prep your ingredients.', 'Cook over medium heat until done.', 'Season to taste and serve!'];

    recordPantryTrends('', missing);

    const sponsor = getContextualSponsor(`${title} ${recipe.canonicalDish || ''} ${recipe.mainIngredient || ''}`, filterStyle, usedSponsors);
    const normalizedRecipe = { ...recipe, id: recipeId, title, time, calories, protein, costThb, macros, allIngredients, missingItems: missing, steps, sponsor };
    recipeStore.set(recipeId, normalizedRecipe);
    prepared.push(normalizedRecipe);
  }

  // Generate all 3 exact dish photos in parallel for maximum speed!
  const imageUrls = await Promise.all(
    prepared.map((r) => getRecipeImageUrl(r, usedUrls, publicBaseUrl))
  );

  const bubbles = prepared.map((normalizedRecipe, idx) => {
    const { id: recipeId, title, time, macros, missingItems: missing, sponsor } = normalizedRecipe;
    const imageUrl = imageUrls[idx];
    const hasMissing = missing[0] !== 'None — ready to cook!' && !/^none/i.test(missing[0]);

    return {
      type: 'bubble',
      size: 'mega',
      hero: { type: 'image', url: imageUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `${normalizedRecipe.emoji || '🍳'} ${title}`, weight: 'bold', size: 'lg', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ECFDF5',
            cornerRadius: 'md',
            paddingAll: 'xs',
            contents: [{ type: 'text', text: `🔥 ${macros}`, size: 'xs', weight: 'bold', color: '#047857', align: 'center' }],
          },
          {
            type: 'box',
            layout: 'baseline',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '⏱️ Time:', size: 'xs', color: '#888888', flex: 2 },
              { type: 'text', text: time, size: 'xs', color: '#333333', flex: 5, wrap: true },
            ],
          },
          {
            type: 'box',
            layout: 'baseline',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '🛒 Missing:', size: 'xs', color: '#888888', flex: 2 },
              { type: 'text', text: hasMissing ? `${missing.length} items (${missing.join(', ')})` : missing[0], size: 'xs', color: hasMissing ? '#DC2626' : '#059669', flex: 5, wrap: true },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFFBEB',
            cornerRadius: 'md',
            paddingAll: 'xs',
            margin: 'xs',
            action: { type: 'postback', label: 'Claim Partner Promo', data: `action=sponsor_click&id=${recipeId}`, displayText: `🏷️ ${sponsor.sponsor} Deal` },
            contents: [
              { type: 'text', text: `AD • ${sponsor.sponsor}`, size: 'xxs', weight: 'bold', color: '#B45309' },
              { type: 'text', text: sponsor.tagline, size: 'xs', color: '#78350F', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: '👨‍🍳 Start Cook Mode', data: `action=cook&id=${recipeId}&step=0`, displayText: `Start cooking ${title}`.slice(0, 300) } },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'xs',
            contents: [
              { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'postback', label: hasMissing ? `🛒 Buy (${missing.length})` : '🛒 Ready (0)', data: `action=missing&id=${recipeId}`, displayText: `Order missing items for ${title}`.slice(0, 300) } },
              { type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'postback', label: '❤️ Save', data: `action=save&id=${recipeId}`, displayText: `Save ${title}`.slice(0, 300) } },
            ],
          },
        ],
      },
    };
  });

  const msg = { type: 'flex', altText: 'FridgeFriend Recipe Suggestions 🍳', contents: { type: 'carousel', contents: bubbles } };
  if (includeQuickReplies) msg.quickReply = getFilterQuickReplies();
  return msg;
}

function buildMealPlanCarousel(planData) {
  const planId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const days = Array.isArray(planData?.days) && planData.days.length > 0
    ? planData.days.slice(0, 3)
    : [{ focus: 'Balanced Prep Day', lunch: 'Garlic Chicken Rice Bowl', lunchMacros: '480 kcal | 40g P', dinner: 'Stir-Fried Egg & Greens', dinnerMacros: '420 kcal | 28g P', ingredientsNeeded: ['500g chicken breast', '6 eggs', 'garlic', 'soy sauce', 'rice'], wasteTip: 'Cook extra rice for Day 2 fried rice.' }];

  const combinedItems = new Set();
  for (const item of planData?.consolidatedShoppingList || []) if (item && typeof item === 'string') combinedItems.add(item.trim());
  for (const d of days) for (const ing of d.ingredientsNeeded || []) if (ing && typeof ing === 'string') combinedItems.add(ing.trim());
  const finalShoppingList = combinedItems.size > 0 ? Array.from(combinedItems) : ['Chicken breast (500g)', 'Eggs (6 pcs)', 'Garlic & shallots', 'Rice & soy sauce'];
  mealPlanStore.set(planId, finalShoppingList);

  const dayBubbles = days.map((d, idx) => ({
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#065F46',
      contents: [
        { type: 'text', text: `🗓️ DAY ${idx + 1} MEAL PREP`, color: '#A7F3D0', size: 'xs', weight: 'bold' },
        { type: 'text', text: d.focus || 'Zero-Waste Balanced Day', color: '#FFFFFF', size: 'md', weight: 'bold', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'box', layout: 'vertical', spacing: 'xs', contents: [{ type: 'text', text: '☀️ LUNCH', size: 'xs', weight: 'bold', color: '#10B981' }, { type: 'text', text: d.lunch || 'Chicken Garlic Bowl', size: 'sm', weight: 'bold', wrap: true }, { type: 'text', text: d.lunchMacros || '480 kcal | 38g P', size: 'xs', color: '#6B7280' }] },
        { type: 'separator' },
        { type: 'box', layout: 'vertical', spacing: 'xs', contents: [{ type: 'text', text: '🌙 DINNER', size: 'xs', weight: 'bold', color: '#059669' }, { type: 'text', text: d.dinner || 'Stir-Fried Veggies & Protein', size: 'sm', weight: 'bold', wrap: true }, { type: 'text', text: d.dinnerMacros || '510 kcal | 42g P', size: 'xs', color: '#6B7280' }] },
        { type: 'separator' },
        { type: 'text', text: `♻️ Zero-Waste Tip: ${d.wasteTip || 'Uses fresh perishables first.'}`, size: 'xs', color: '#047857', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: `🛒 Order 3-Day Groceries (${finalShoppingList.length})`, data: `action=plan_list&id=${planId}`, displayText: 'Show 3-Day Consolidated Shopping List 🛒' } }],
    },
  }));

  return { type: 'flex', altText: '🗓️ 3-Day Zero-Waste Meal Plan', contents: { type: 'carousel', contents: dayBubbles }, quickReply: getFilterQuickReplies() };
}

function buildSingleStepCard(recipe, stepIndex) {
  const total = recipe.steps.length;
  const currentStep = recipe.steps[stepIndex] || 'Enjoy your meal!';
  const isLast = stepIndex >= total - 1;
  const timeMatch = currentStep.match(/(\d+)\s*(?:minute|minutes|min|mins|m|นาที|မိနစ်)\b/i);
  const detectedMinutes = timeMatch ? Math.min(parseInt(timeMatch[1], 10), 60) : null;
  const footerButtons = [];

  if (detectedMinutes && detectedMinutes > 0) {
    footerButtons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: `⏱️ Set ${detectedMinutes}m Timer`, data: `action=timer&mins=${detectedMinutes}&title=${encodeURIComponent(recipe.title)}`, displayText: `Set ${detectedMinutes}-minute timer ⏱️` } });
  }
  if (!isLast) {
    footerButtons.push({ type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: `Next Step (${stepIndex + 2}/${total}) ➡️`, data: `action=cook&id=${recipe.id}&step=${stepIndex + 1}`, displayText: `Step ${stepIndex + 2}` } });
  } else {
    footerButtons.push({ type: 'button', style: 'primary', color: '#059669', height: 'sm', action: { type: 'postback', label: `✅ I Cooked This (+${recipe.protein}g Protein)`, data: `action=log_meal&id=${recipe.id}`, displayText: `Logged ${recipe.title}! 💪` } });
  }

  return {
    type: 'flex',
    altText: `Step ${stepIndex + 1}/${total}: ${recipe.title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `STEP ${stepIndex + 1} OF ${total}`, weight: 'bold', size: 'xs', color: '#10B981' },
          { type: 'text', text: `${recipe.emoji || '🍳'} ${recipe.title}`, weight: 'bold', size: 'md', wrap: true },
          { type: 'separator' },
          { type: 'text', text: currentStep, size: 'md', color: '#1F2937', wrap: true },
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'xs', contents: footerButtons },
    },
  };
}

function buildReceiptCard(items, receiptBatchId) {
  return {
    type: 'flex',
    altText: '🧾 Receipt Scanned!',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '🧾 Grocery Receipt Scanned', weight: 'bold', size: 'lg', color: '#10B981' },
          { type: 'text', text: `Found ${items.length} food item(s):`, size: 'xs', color: '#6B7280' },
          { type: 'separator' },
          ...items.map((item) => ({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs', contents: [{ type: 'text', text: '🥬', size: 'sm', flex: 0 }, { type: 'text', text: item, size: 'sm', color: '#333333', wrap: true, flex: 1 }] })),
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'xs', contents: [{ type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: '🍳 Cook With These Items', data: `action=receipt_cook&batch=${receiptBatchId}`, displayText: 'Cook with scanned receipt items 🍳' } }] },
    },
  };
}

function buildStatsCard(session) {
  const today = getTodayKey();
  const log = session.logs[today] || { calories: 0, protein: 0, meals: [] };
  const calGoal = Number(session.goals.calories) || 2000;
  const proGoal = Number(session.goals.protein) || 130;
  const calPct = Math.min(Math.round((log.calories / calGoal) * 100), 100);
  const proPct = Math.min(Math.round((log.protein / proGoal) * 100), 100);

  const gymSection = session.gymPartner
    ? [{
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#EFF6FF',
        cornerRadius: 'md',
        paddingAll: 'xs',
        contents: [{ type: 'text', text: `🏋️ Verified Partner Member: ${session.gymPartner}`, size: 'xs', weight: 'bold', color: '#1D4ED8', align: 'center', wrap: true }],
      }]
    : [{
        type: 'text',
        text: '💡 Have a partner gym/clinic code? Type: redeem FITFIRST26',
        size: 'xxs',
        color: '#6B7280',
        wrap: true,
      }];

  const mealLines = log.meals.length > 0
    ? log.meals.map((m) => ({ type: 'text', text: `• ${m.title} (${m.calories} kcal, ${m.protein}g P)`, size: 'xs', color: '#4B5563', wrap: true }))
    : [{ type: 'text', text: 'No meals cooked yet today — tap "✅ I Cooked This" after cooking!', size: 'xs', color: '#9CA3AF', wrap: true }];

  return {
    type: 'flex',
    altText: '📊 Daily Nutrition Stats',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `📊 Daily Macros (${today})`, weight: 'bold', size: 'lg', color: '#111827' },
          ...gymSection,
          { type: 'text', text: `🎯 Target: ${session.goals.label || `${calGoal} kcal | ${proGoal}g P`}`, size: 'xs', color: '#059669', weight: 'bold' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: `💪 Protein: ${log.protein}g / ${proGoal}g (${proPct}%)`, size: 'sm', weight: 'bold', color: '#047857' },
              { type: 'box', layout: 'vertical', backgroundColor: '#E5E7EB', height: '8px', cornerRadius: 'md', contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#10B981', height: '8px', width: `${Math.max(proPct, 4)}%`, cornerRadius: 'md', contents: [] }] },
            ],
          },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: `🔥 Calories: ${log.calories} / ${calGoal} kcal (${calPct}%)`, size: 'sm', weight: 'bold', color: '#B45309' },
              { type: 'box', layout: 'vertical', backgroundColor: '#E5E7EB', height: '8px', cornerRadius: 'md', contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#F59E0B', height: '8px', width: `${Math.max(calPct, 4)}%`, cornerRadius: 'md', contents: [] }] },
            ],
          },
          { type: 'separator' },
          { type: 'text', text: '🍽️ Meals Logged Today:', size: 'xs', weight: 'bold', color: '#374151' },
          ...mealLines,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '⚙️ Customize Calorie & Protein Goal', data: 'action=goal_menu', displayText: '⚙️ Customize Daily Macro Goals' } },
        ],
      },
    },
    quickReply: getFilterQuickReplies(),
  };
}

function buildGoalPickerCard(session) {
  return {
    type: 'flex',
    altText: '⚙️ Set Daily Calorie & Protein Goal',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '⚙️ Set Your Daily Targets', weight: 'bold', size: 'lg', color: '#111827' },
          { type: 'text', text: `Current: ${session.goals.calories} kcal | ${session.goals.protein}g protein\nChoose a preset below, or type: goal 2200 150`, size: 'xs', color: '#4B5563', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'xs',
        contents: [
          { type: 'button', style: 'primary', color: '#059669', height: 'sm', action: { type: 'postback', label: '💪 Lean Bulk (2500 kcal | 150g P)', data: 'action=set_goal&cal=2500&pro=150&label=Lean+Bulk', displayText: 'Set goal: Lean Bulk (2500 kcal | 150g P)' } },
          { type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: '⚖️ Maintain (2000 kcal | 120g P)', data: 'action=set_goal&cal=2000&pro=120&label=Maintain', displayText: 'Set goal: Maintain (2000 kcal | 120g P)' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🥗 Fat Loss / Cut (1650 kcal | 135g P)', data: 'action=set_goal&cal=1650&pro=135&label=Fat+Loss+Cut', displayText: 'Set goal: Fat Loss / Cut (1650 kcal | 135g P)' } },
        ],
      },
    },
  };
}

// --- Stream 1: Shopping List + 1-Tap Affiliate Delivery Monetization Card ---
function buildShoppingListCard(title, items, allIngredients = []) {
  const missingRows = items.map((item) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
    contents: [{ type: 'text', text: '⬜', size: 'sm', flex: 0 }, { type: 'text', text: item, size: 'sm', color: '#DC2626', weight: 'bold', wrap: true, flex: 1 }],
  }));

  const fullListSection = Array.isArray(allIngredients) && allIngredients.length > 0
    ? [
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '📋 Full Recipe Ingredients:', size: 'xs', weight: 'bold', color: '#374151', margin: 'md' },
        ...allIngredients.map((ing) => ({ type: 'text', text: `• ${ing}`, size: 'xs', color: '#4B5563', wrap: true })),
      ]
    : [];

  const firstCleanItem = (items[0] || 'groceries').replace(/^[\d./]+\s*(?:tbsp|tsp|cup|cups|g|kg|ml|l|pcs|cloves|bunch|bottle)?\s*/i, '').trim();
  const query = encodeURIComponent(firstCleanItem || 'chicken');

  return {
    type: 'flex',
    altText: `Shopping List: ${title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: `🛒 Missing Ingredients (${/^none/i.test(items[0] || '') ? 0 : items.length})`, weight: 'bold', size: 'lg', color: '#10B981' },
          { type: 'text', text: title, size: 'xs', color: '#6B7280', margin: 'xs', wrap: true },
          { type: 'separator', margin: 'md' },
          ...missingRows,
          ...fullListSection,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'text', text: '⚡ Instant Partner Grocery Delivery (Affiliate)', size: 'xxs', color: '#6B7280', align: 'center' },
          { type: 'button', style: 'primary', color: '#00B14F', height: 'sm', action: { type: 'uri', label: '🛵 Order via GrabMart Partner', uri: 'https://food.grab.com/th/en/' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '🛍️ Buy Ingredients on Tops Online', uri: `https://www.tops.co.th/en/search/${query}` } },
        ],
      },
    },
  };
}

// --- Gemini AI Generators (Auto-Matches Burmese / Thai / English Output) ---
async function generateRecipesForSession(session, filterStyle = null, publicBaseUrl = '') {
  const styleInstructions = {
    budget_60: 'Focus strictly on STUDENT BUDGET-FRIENDLY meals costing UNDER 60 THB per serving using affordable local Thai ingredients.',
    high_protein: 'Focus strictly on HIGH-PROTEIN fitness meals (40g+ protein per serving).',
    quick_15m: 'Focus strictly on ULTRA-FAST meals ready in 15 MINUTES OR LESS total.',
    thai_style: 'Focus strictly on authentic THAI-STYLE dishes (e.g., pad kra pao, Thai garlic pepper, spicy lime salad).',
  };
  const extraRule = filterStyle && styleInstructions[filterStyle] ? styleInstructions[filterStyle] : '';

  const schemaPrompt = `${extraRule}
LANGUAGE RULE (CRITICAL):
- Detect the language of the user's input (Burmese မြန်မာဘာသာ, Thai ภาษาไทย, or English).
- Write "title", "time", "allIngredients", "missingItems", and "steps" in THAT EXACT SAME LANGUAGE (e.g., if the user writes or speaks in Burmese, write natural Burmese; if in Thai, write natural Thai; if in English or an image without text, write in English).
- ALWAYS keep "canonicalDish" and "mainIngredient" in ENGLISH so dish photo generation matches the exact food visually.

IMPORTANT INGREDIENT RULE:
- Compare EVERY ingredient required to cook the dish (including cooking oil, sauces, seasonings, sugar, salt, aromatics, vegetables, and rice/noodles) against ONLY what the user explicitly provided.
- Put EVERY SINGLE ingredient the user did NOT mention or show in the photo inside "missingItems" with exact quantities (do NOT cap at 1 or 2 items—list ALL 3, 4, 5+ missing items honestly!).
- Also list every ingredient used in the recipe inside "allIngredients".

Return ONLY valid JSON (no markdown) matching this exact format:
{
  "recipes": [
    {
      "title": "Dish Name in user's language",
      "emoji": "🍗",
      "canonicalDish": "clear visual ENGLISH description of the finished plated dish (e.g., Thai Basil Chicken Stir Fry with Fried Egg on Rice, Burmese Chicken and Potato Curry, Crispy Tomato Egg Omelette)",
      "mainIngredient": "single primary ingredient in lowercase ENGLISH (e.g., chicken, egg, pork, shrimp, beef, salmon, tofu, pasta)",
      "calories": 520,
      "protein": 44,
      "costThb": 48,
      "time": "5m prep | 12m cook (in user's language)",
      "allIngredients": ["200g chicken breast", "2 cloves garlic", "1 tbsp soy sauce"],
      "missingItems": ["1 tbsp soy sauce", "1 tbsp oyster sauce", "1 cup steamed rice"],
      "steps": ["Step 1 instruction in user's language", "Step 2 instruction", "Step 3 instruction"]
    }
  ]
}
Suggest 3 distinct, practical, delicious recipes.`;

  const geminiContents = session.lastPromptType === 'image' && session.lastImageBase64
    ? [{ inlineData: { mimeType: 'image/jpeg', data: session.lastImageBase64 } }, `You are FridgeFriend, an AI chef. Identify the ingredients in this photo and suggest 3 recipes using them. ${schemaPrompt}`]
    : `You are FridgeFriend, an AI chef. User ingredients: "${session.lastText}". ${schemaPrompt}`;

  const response = await generateWithFallback(geminiContents, { responseMimeType: 'application/json' });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
  const recipeList = Array.isArray(parsed) ? parsed : (parsed.recipes || parsed.meals || Object.values(parsed).find(Array.isArray) || []);
  return buildRecipeCarousel(recipeList, true, filterStyle || '', publicBaseUrl);
}

async function generateMealPlanForSession(session) {
  const planPrompt = `Create a smart 3-Day Zero-Waste Meal Plan (Lunch & Dinner for 3 days = 6 meals total) that uses up perishable ingredients first so nothing spoils.
LANGUAGE RULE: If the user's ingredients are in Burmese (မြန်မာဘာသာ) or Thai (ภาษาไทย), write "focus", "lunch", "dinner", "ingredientsNeeded", "wasteTip", and "consolidatedShoppingList" in THAT SAME LANGUAGE; otherwise write in English.
For EVERY day, list the real, specific grocery/food ingredients needed to cook that day's Lunch & Dinner inside "ingredientsNeeded" (with practical quantities), and put the complete combined shopping list across all 3 days inside "consolidatedShoppingList".
Return ONLY valid JSON (no markdown) matching this exact format:
{
  "days": [
    {
      "focus": "Use Fresh Meat & Greens First",
      "lunch": "Dish Name",
      "lunchMacros": "480 kcal | 40g P",
      "dinner": "Dish Name",
      "dinnerMacros": "520 kcal | 42g P",
      "ingredientsNeeded": ["300g chicken breast", "2 cloves garlic", "1 cup jasmine rice"],
      "wasteTip": "Short tip on how leftover ingredients carry over to Day 2"
    }
  ],
  "consolidatedShoppingList": ["600g chicken breast", "6 eggs", "1 bunch holy basil", "1 bottle soy sauce", "1kg jasmine rice"]
}`;

  const geminiContents = session.lastPromptType === 'image' && session.lastImageBase64
    ? [{ inlineData: { mimeType: 'image/jpeg', data: session.lastImageBase64 } }, `You are FridgeFriend, a zero-waste meal planner. Based on the ingredients in this photo, ${planPrompt}`]
    : `You are FridgeFriend, a zero-waste meal planner. User ingredients: "${session.lastText || 'chicken breast, eggs, garlic, soy sauce, rice, vegetables'}". ${planPrompt}`;

  const response = await generateWithFallback(geminiContents, { responseMimeType: 'application/json' });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
  const normalizedPlan = Array.isArray(parsed) ? { days: parsed } : parsed;
  return buildMealPlanCarousel(normalizedPlan);
}

// --- Webhook Event Handler ---
async function handleEvent(event, publicBaseUrl = '') {
  const userId = event.source?.userId || 'default_user';
  const session = getSession(userId);

  if (event.type === 'follow') {
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'sponsor_click') {
      const recipe = recipeStore.get(params.get('id'));
      const sponsor = recipe?.sponsor || getContextualSponsor();
      db.analytics.sponsoredClicks = (db.analytics.sponsoredClicks || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `🏷️ Partner Offer Unlocked!\n\nPartner: ${sponsor.sponsor}\nPromo Code: ${sponsor.promoCode}\nLink: ${sponsor.url}`,
        }],
      });
    }

    if (action === 'flash_deal') {
      db.analytics.couponClaims = (db.analytics.couponClaims || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildFlashDealCard()],
      });
    }

    if (action === 'cook') {
      const recipe = recipeStore.get(params.get('id'));
      const stepIdx = parseInt(params.get('step') || '0', 10);
      if (!recipe) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: 'Recipe expired—send your ingredients again for fresh ideas! 🥦' }] });
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildSingleStepCard(recipe, stepIdx)] });
    }

    if (action === 'timer') {
      const mins = parseInt(params.get('mins') || '5', 10);
      const dishTitle = params.get('title') || 'your dish';
      setTimeout(() => {
        if (event.source?.userId) {
          messagingClient.pushMessage({ to: event.source.userId, messages: [{ type: 'text', text: `⏰ Ding! Your ${mins}-minute timer for ${dishTitle} is up! 🔥🍳` }] }).catch((e) => console.error('Timer push failed:', e.message));
        }
      }, mins * 60 * 1000);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `⏱️ Timer set for ${mins} minute(s)! I'll ping you right here when it's done.` }] });
    }

    if (action === 'missing') {
      const recipe = recipeStore.get(params.get('id'));
      if (!recipe) return null;
      db.analytics.affiliateClicks = (db.analytics.affiliateClicks || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildShoppingListCard(`For: ${recipe.title}`, recipe.missingItems, recipe.allIngredients)] });
    }

    if (action === 'plan_list') {
      const items = mealPlanStore.get(params.get('id')) || ['Chicken breast, eggs, garlic, rice, soy sauce'];
      db.analytics.affiliateClicks = (db.analytics.affiliateClicks || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildShoppingListCard('3-Day Meal Prep Ingredients', items)] });
    }

    if (action === 'save') {
      const recipe = recipeStore.get(params.get('id'));
      if (!recipe) return null;
      if (!session.saved.some((r) => r.title === recipe.title)) { session.saved.push(recipe); saveDB(); }
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `❤️ Saved "${recipe.title}" to My Cookbook! Tap "📖 My Cookbook" in the bottom menu anytime.` }] });
    }

    if (action === 'log_meal') {
      const recipe = recipeStore.get(params.get('id'));
      if (!recipe) return null;
      const today = getTodayKey();
      session.logs[today].calories += Number(recipe.calories) || 450;
      session.logs[today].protein += Number(recipe.protein) || 32;
      session.logs[today].meals.push({ title: recipe.title, calories: recipe.calories, protein: recipe.protein });
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildStatsCard(session)] });
    }

    if (action === 'goal_menu') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildGoalPickerCard(session)] });
    }

    if (action === 'set_goal') {
      const cal = parseInt(params.get('cal') || '2000', 10);
      const pro = parseInt(params.get('pro') || '130', 10);
      const label = params.get('label') || `${cal} kcal | ${pro}g P`;
      session.goals = { calories: cal, protein: pro, label };
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ Updated your daily target to ${cal} kcal & ${pro}g protein!` }, buildStatsCard(session)] });
    }

    if (action === 'receipt_cook') {
      const items = pendingReceiptItems.get(params.get('batch')) || [];
      if (items.length === 0) return null;
      session.lastPromptType = 'text';
      session.lastText = items.join(', ');
      recordPantryTrends(session.lastText, []);
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const carousel = await generateRecipesForSession(session, null, publicBaseUrl);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🍳 Cooking with your ${items.length} scanned receipt items:` }, carousel] });
    }

    if (action === 'meal_plan') {
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const planCarousel = await generateMealPlanForSession(session);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [planCarousel] });
    }

    if (action === 'filter') {
      if (!session.lastPromptType) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: 'Send ingredients, a voice note, or a fridge photo first! 🥦📸' }] });
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const carousel = await generateRecipesForSession(session, params.get('style'), publicBaseUrl);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [carousel] });
    }
  }

  if (event.type !== 'message') return null;

  if (event.message.type === 'text') {
    const rawText = event.message.text.trim();
    const lower = rawText.toLowerCase();

    if (lower === 'help' || lower === 'menu' || lower === 'hi' || lower === 'hello' || lower === 'สวัสดี' || lower === 'မင်္ဂလာပါ') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
    }

    if (lower === 'deal' || lower === 'coupon' || lower === 'flash') {
      db.analytics.couponClaims = (db.analytics.couponClaims || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildFlashDealCard()] });
    }

    // Stream 4: Verified B2B Partner Code Redemption (Gated by Partner Invite Code)
    if (lower.startsWith('redeem ')) {
      const code = rawText.slice(7).trim().toUpperCase();
      const partnerInfo = B2B_PARTNER_CODES[code];
      if (!partnerInfo) {
        return messagingClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '❌ Invalid B2B partner code. Please enter the invite code issued by your partner gym or nutrition clinic.',
          }],
        });
      }
      if (!session.gymPartner) {
        db.analytics.gymActivations = (db.analytics.gymActivations || 0) + 1;
      }
      session.gymPartner = partnerInfo.partner;
      session.goals = {
        calories: partnerInfo.calories,
        protein: partnerInfo.protein,
        label: `${partnerInfo.partner} Plan`,
      };
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: 'text',
            text: `✅ Verified Partner Code (${code})!\nLinked to: ${partnerInfo.partner}\nYour coach's macro targets (${partnerInfo.calories} kcal | ${partnerInfo.protein}g protein) are now active.`,
          },
          buildStatsCard(session),
        ],
      });
    }

    if (lower === 'unredeem' || lower === 'cancel gym' || lower === 'cancel') {
      if (!session.gymPartner) {
        return messagingClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: 'ℹ️ You do not have an active B2B partner gym pass right now.' }],
        });
      }
      const oldPartner = session.gymPartner;
      session.gymPartner = null;
      session.goals = { calories: 2000, protein: 130, label: 'Balanced (2000 kcal)' };
      if (db.analytics.gymActivations > 0) {
        db.analytics.gymActivations -= 1;
      }
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: 'text',
            text: `🔓 Unlinked from ${oldPartner}. Your account has returned to standard Free Mode (2000 kcal | 130g protein).`,
          },
          buildStatsCard(session),
        ],
      });
    }

    // Stream 5 + Executive Flex Card: B2B Revenue & Analytics Dashboard
    if (lower === 'revenue' || lower === 'ads' || lower === 'business') {
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildB2BRevenueCard()],
      });
    }

    if (lower.startsWith('goal ')) {
      const nums = rawText.match(/\d+/g);
      if (nums && nums.length >= 2) {
        const cal = parseInt(nums[0], 10);
        const pro = parseInt(nums[1], 10);
        session.goals = { calories: cal, protein: pro, label: `Custom (${cal} kcal | ${pro}g P)` };
        saveDB();
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ Custom target saved: ${cal} kcal & ${pro}g protein!` }, buildStatsCard(session)] });
      }
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildGoalPickerCard(session)] });
    }

    if (lower === 'stats' || lower === 'macros') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildStatsCard(session)] });
    }

    if (lower === 'saved' || lower === 'cookbook' || lower === 'favorites') {
      if (session.saved.length === 0) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '📖 Your Cookbook is empty! Tap "❤️ Save" on any recipe card to save it here.' }] });
      const savedCarousel = await buildRecipeCarousel(session.saved, false, '', publicBaseUrl);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [savedCarousel] });
    }

    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    session.lastPromptType = 'text';
    session.lastText = rawText;
    session.lastImageBase64 = null;
    recordPantryTrends(rawText, []);

    const carousel = await generateRecipesForSession(session, null, publicBaseUrl);
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [carousel] });
  }

  if (event.message.type === 'image') {
    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    const base64Image = await getMessageBase64(event.message.id);

    const classifyRes = await generateWithFallback(
      [
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        `Analyze this image. Is it a shopping/grocery RECEIPT, or a photo of FOOD/FRIDGE ingredients? Return ONLY valid JSON: { "type": "receipt" or "food", "receiptFoodItems": ["item 1", "item 2"] }`,
      ],
      { responseMimeType: 'application/json' }
    );

    const parsedClass = JSON.parse(classifyRes.text.replace(/```json|```/g, '').trim());
    if (parsedClass.type === 'receipt' && Array.isArray(parsedClass.receiptFoodItems) && parsedClass.receiptFoodItems.length > 0) {
      const batchId = `${Date.now()}`;
      pendingReceiptItems.set(batchId, parsedClass.receiptFoodItems);
      recordPantryTrends(parsedClass.receiptFoodItems.join(', '), []);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildReceiptCard(parsedClass.receiptFoodItems, batchId)] });
    }

    session.lastPromptType = 'image';
    session.lastImageBase64 = base64Image;
    session.lastText = '';
    saveDB();

    const carousel = await generateRecipesForSession(session, null, publicBaseUrl);
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [carousel] });
  }

  if (event.message.type === 'audio') {
    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    const base64Audio = await getMessageBase64(event.message.id);

    const transcribeRes = await generateWithFallback([
      { inlineData: { mimeType: 'audio/m4a', data: base64Audio } },
      'Extract ONLY the food ingredients and cooking preferences spoken in this voice note as a concise comma-separated phrase, preserving the exact spoken language (Burmese, Thai, or English).',
    ]);

    const spokenIngredients = transcribeRes.text.trim();
    session.lastPromptType = 'text';
    session.lastText = spokenIngredients;
    session.lastImageBase64 = null;
    recordPantryTrends(spokenIngredients, []);

    const carousel = await generateRecipesForSession(session, null, publicBaseUrl);
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🎙️ Heard: "${spokenIngredients}"` }, carousel] });
  }

  return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
}

// Wrap webhook route to pass the incoming Render HTTPS host automatically
app._router.stack.forEach((layer) => {
  if (layer.route && layer.route.path === '/webhook') {
    layer.route.stack[layer.route.stack.length - 1].handle = (req, res) => {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const publicBaseUrl = host ? `${proto}://${host}` : '';
      console.log('📩 Webhook hit! Events:', req.body.events.length, '| BaseURL:', publicBaseUrl);
      res.status(200).end();
      req.body.events.forEach((event) => {
        handleEvent(event, publicBaseUrl).catch((err) =>
          console.error('❌ Error:', err?.status, err?.message, JSON.stringify(err?.errors || err?.body || ''))
        );
      });
    };
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`🚀 FridgeFriend Pro running on port ${PORT}`);
  await setupRichMenu();
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, saving db.json and closing server...');
  saveDB();
  server.close(() => process.exit(0));
});