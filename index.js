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
const pendingPantryItems = new Map(); // batchId -> array of ingredient strings (editable working list)
let cachedModels = null;

// Clean up expired cache every 30 minutes (keeps RAM flat for 70+ users)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const key of recipeStore.keys()) {
    const ts = Number(key.split('_')[0]);
    if (ts && ts < cutoff) recipeStore.delete(key);
  }
  for (const key of mealPlanStore.keys()) {
    const ts = Number(key.split('_')[0]);
    if (ts && ts < cutoff) mealPlanStore.delete(key);
  }
  for (const key of pendingReceiptItems.keys()) {
    const ts = Number(key);
    if (ts && ts < cutoff) pendingReceiptItems.delete(key);
  }
  for (const key of pendingPantryItems.keys()) {
    const ts = Number(key);
    if (ts && ts < cutoff) pendingPantryItems.delete(key);
  }
}, 30 * 60 * 1000).unref();

// --- Multi-Language UI Strings Dictionary (Refined EN / TH / MY — No အမယ်) ---
const UI_STRINGS = {
  en: {
    bestMatch: '🏆 BEST MATCH',
    option: '✨ OPTION',
    uses: '🥬 Uses',
    need: '🛒 Need',
    itemsUnit: 'items',
    readyCook: '✅ Ready to cook — 0 missing items!',
    cookBtn: "👨‍🍳 Let's Cook!",
    buyBtn: '🛒 Buy',
    readyBtn: '✅ Ready',
    saveBtn: '❤️ Save',
    stepTitle: 'STEP',
    of: 'OF',
    nextStepBtn: 'Next Step',
    setTimerBtn: '⏱️ Set Timer',
    minsUnit: 'm',
    prepCheck: '📋 Complete Ingredients Needed:',
    cookedBtn: '✅ I Cooked This',
    dailyMacros: '📊 Daily Macros',
    target: '🎯 Target',
    protein: 'Protein',
    calories: 'Calories',
    mealsLogged: '🍽️ Meals Logged Today:',
    missingHeader: '🛒 Missing Ingredients to Buy',
    fullRecipeHeader: '📋 Complete Recipe Ingredients (Have + Need):',
    havePrefix: '✅ Have',
    needPrefix: '🛒 Need',
    verifyTitle: '🔍 Verify Scanned Ingredients',
    verifySubtitle: 'We detected these items in your photo. Are they correct?',
    confirmBtn: '✅ Correct & Find Recipes',
    editBtn: '✏️ Edit Ingredients',
    // --- Edit flow ---
    detected: 'Detected ingredients',
    editChoiceTitle: '✏️ Edit Ingredients',
    editChoiceSubtitle: 'Would you like to add missing items or remove wrong ones?',
    addBtn: '➕ Add ingredients',
    deleteBtn: '➖ Delete ingredients',
    cancelBtn: '↩️ Back to list',
    addPrompt: '➕ Type the ingredients you want to ADD, separated by commas (e.g., egg, tomato, fish sauce):',
    deletePrompt: '➖ Type the ingredients you want to REMOVE from the list (e.g., garlic, tomato):',
    addedMsg: 'Added',
    removedMsg: 'Removed',
    alreadyInListMsg: 'Already in list',
    notFoundMsg: 'Not found in list',
    noChange: 'No changes made.',
    emptyList: '(Your ingredient list is empty)',
    emptyConfirm: '⚠️ Your ingredient list is empty — please add at least 1 ingredient first.',
    expired: '⚠️ This list expired — please send your ingredients or photo again. 🥦📸',
  },
  th: {
    bestMatch: '🏆 แนะนำที่สุด',
    option: '✨ เมนูที่',
    uses: '🥬 ใช้วัตถุดิบที่มี',
    need: '🛒 ต้องซื้อเพิ่ม',
    itemsUnit: 'อย่าง',
    readyCook: '✅ พร้อมทำทันที — วัตถุดิบครบ!',
    cookBtn: '👨‍🍳 เริ่มทำอาหาร',
    buyBtn: '🛒 ซื้อเพิ่ม',
    readyBtn: '✅ ครบแล้ว',
    saveBtn: '❤️ บันทึก',
    stepTitle: 'ขั้นตอนที่',
    of: 'จาก',
    nextStepBtn: 'ขั้นตอนถัดไป',
    setTimerBtn: '⏱️ ตั้งเวลา',
    minsUnit: 'นาที',
    prepCheck: '📋 วัตถุดิบและเครื่องปรุงทั้งหมดที่ใช้:',
    cookedBtn: '✅ ทำเมนูนี้เสร็จแล้ว',
    dailyMacros: '📊 สรุปสารอาหารประจำวัน',
    target: '🎯 เป้าหมาย',
    protein: 'โปรตีน',
    calories: 'แคลอรี',
    mealsLogged: '🍽️ เมนูที่ทานวันนี้:',
    missingHeader: '🛒 วัตถุดิบที่ต้องซื้อเพิ่ม',
    fullRecipeHeader: '📋 วัตถุดิบทั้งหมดของเมนูนี้ (ที่มี + ต้องซื้อเพิ่ม):',
    havePrefix: '✅ มีแล้ว',
    needPrefix: '🛒 ซื้อเพิ่ม',
    verifyTitle: '🔍 ตรวจสอบวัตถุดิบที่สแกนพบ',
    verifySubtitle: 'ตรวจพบวัตถุดิบตามรายการนี้ ครบถูกต้องไหม?',
    confirmBtn: '✅ ถูกต้อง & ค้นหาเมนู',
    editBtn: '✏️ แก้ไขรายการวัตถุดิบ',
    confirmedHeader: '🍳 กำลังคิดค้นเมนูอร่อยจากวัตถุดิบของคุณ...',
    detected: 'วัตถุดิบที่พบทั้งหมด',
    editChoiceTitle: '✏️ แก้ไขรายการวัตถุดิบ',
    editChoiceSubtitle: 'ต้องการเพิ่มวัตถุดิบที่ตกหล่น หรือลบรายการที่ไม่ใช่ออก?',
    addBtn: '➕ เพิ่มวัตถุดิบ',
    deleteBtn: '➖ ลบวัตถุดิบ',
    cancelBtn: '↩️ กลับไปหน้ารายการ',
    addPrompt: '➕ พิมพ์ชื่อวัตถุดิบที่ต้องการ "เพิ่ม" คั่นด้วยลูกน้ำ (เช่น ไข่ไก่, มะเขือเทศ, น้ำปลา):',
    deletePrompt: '➖ พิมพ์ชื่อวัตถุดิบที่ต้องการ "ลบ" ออกจากรายการ (เช่น กระเทียม, มะเขือเทศ):',
    addedMsg: 'เพิ่มเรียบร้อย',
    removedMsg: 'ลบเรียบร้อย',
    alreadyInListMsg: 'มีในรายการอยู่แล้ว',
    notFoundMsg: 'ไม่พบในรายการ',
    noChange: 'ไม่มีการเปลี่ยนแปลงรายการ',
    emptyList: '(ยังไม่มีวัตถุดิบในรายการ)',
    emptyConfirm: '⚠️ รายการวัตถุดิบยังว่างอยู่ — กรุณากดเพิ่มวัตถุดิบก่อนนะครับ',
    expired: '⚠️ รายการนี้หมดอายุแล้ว — กรุณาส่งรูปหรือพิมพ์วัตถุดิบใหม่อีกครั้ง 🥦📸',
  },
  my: {
    bestMatch: '🏆 အသင့်တော်ဆုံး',
    option: '✨ ဟင်းပွဲ',
    uses: '🥬 ပါဝင်ပစ္စည်းများ',
    need: '🛒 ထပ်လိုသည့်ပစ္စည်း',
    itemsUnit: 'မျိုး',
    readyCook: '✅ ချက်ပြုတ်ရန် အသင့်ပဲ — လိုအပ်တာမရှိပါ!',
    cookBtn: '👨‍🍳 ချက်ပြုတ်မည်',
    buyBtn: '🛒 ဝယ်ရန်',
    readyBtn: '✅ အသင့်ပဲ',
    saveBtn: '❤️ သိမ်းမည်',
    stepTitle: 'အဆင့်',
    of: '/',
    nextStepBtn: 'နောက်တစ်ဆင့်',
    setTimerBtn: '⏱️ အချိန်မှတ်ရန်',
    minsUnit: 'မိနစ်',
    prepCheck: '📋 လိုအပ်သော ပါဝင်ပစ္စည်း အပြည့်အစုံ:',
    cookedBtn: '✅ ချက်ပြုတ်ပြီးပါပြီ',
    dailyMacros: '📊 ယနေ့ အာဟာရမှတ်တမ်း',
    target: '🎯 ရည်မှန်းချက်',
    protein: 'ပရိုတင်း',
    calories: 'ကယ်လိုရီ',
    mealsLogged: '🍽️ ယနေ့ ချက်ပြုတ်စားသုံးခဲ့သော ဟင်းပွဲများ:',
    missingHeader: '🛒 ထပ်မံဝယ်ယူရန် လိုအပ်သော ပါဝင်ပစ္စည်းများ',
    fullRecipeHeader: '📋 ဤဟင်းပွဲအတွက် လိုအပ်သော ပါဝင်ပစ္စည်းအားလုံး:',
    havePrefix: '✅ ရှိပြီး',
    needPrefix: '🛒 လိုအပ်',
    verifyTitle: '🔍 စကန်ဖတ်ထားသော ပါဝင်ပစ္စည်းများ',
    verifySubtitle: 'ပုံထဲတွင် ဤပါဝင်ပစ္စည်းများကို တွေ့ရှိရပါသည်။ မှန်ကန်ပါသလား?',
    confirmBtn: '✅ မှန်ကန်သည် • ဟင်းပွဲရှာမည်',
    editBtn: '✏️ ပါဝင်ပစ္စည်း ပြင်ဆင်မည်',
    confirmedHeader: '🍳 သင့်ပါဝင်ပစ္စည်းများဖြင့် အရသာရှိသော ဟင်းချက်နည်းများ ရှာဖွေနေပါပြီ...',
    detected: 'တွေ့ရှိထားသော ပါဝင်ပစ္စည်း',
    editChoiceTitle: '✏️ ပါဝင်ပစ္စည်းစာရင်း ပြင်ဆင်ရန်',
    editChoiceSubtitle: 'ကျန်နေသော ပါဝင်ပစ္စည်းများ ထပ်ထည့်မလား သို့မဟုတ် ဖျက်မလား?',
    addBtn: '➕ ပါဝင်ပစ္စည်း ထပ်ထည့်မည်',
    deleteBtn: '➖ ပါဝင်ပစ္စည်း ဖျက်မည်',
    cancelBtn: '↩️ စာရင်းသို့ ပြန်သွားမည်',
    addPrompt: '➕ ထပ်ထည့်လိုသော ပါဝင်ပစ္စည်းများကို ကော်မာ (,) ခံ၍ ရိုက်ပို့ပေးပါ (ဥပမာ - ကြက်ဥ၊ ခရမ်းချဉ်သီး၊ ငံပြာရည်):',
    deletePrompt: '➖ စာရင်းထဲမှ ဖျက်လိုသော ပါဝင်ပစ္စည်းများကို ရိုက်ပို့ပေးပါ (ဥပမာ - ကြက်သွန်ဖြူ၊ ခရမ်းချဉ်သီး):',
    addedMsg: 'ထပ်ထည့်ပြီးပါပြီ',
    removedMsg: 'ဖျက်ပြီးပါပြီ',
    alreadyInListMsg: 'စာရင်းထဲ ရှိပြီးသားဖြစ်သည်',
    notFoundMsg: 'စာရင်းထဲတွင် မတွေ့ပါ',
    noChange: 'ပြောင်းလဲမှု မရှိပါ။',
    emptyList: '(ပါဝင်ပစ္စည်းစာရင်း မရှိသေးပါ)',
    emptyConfirm: '⚠️ ပါဝင်ပစ္စည်းစာရင်း မရှိသေးပါ — ကျေးဇူးပြု၍ ပါဝင်ပစ္စည်းအချို့ အရင်ထည့်ပေးပါ။',
    expired: '⚠️ ဤစာရင်း သက်တမ်းကုန်သွားပါပြီ — ဓာတ်ပုံ သို့မဟုတ် ပါဝင်ပစ္စည်းများ ပြန်ပို့ပေးပါ။ 🥦📸',
  },
};

function t(session, key) {
  const lang = session?.lang && UI_STRINGS[session.lang] ? session.lang : 'en';
  return UI_STRINGS[lang][key] || UI_STRINGS.en[key] || key;
}

// Helper to cleanly strip leading quantities/units without eating the first letter of words like "liters"
function stripLeadingMeasure(str = '') {
  return str
    .replace(
      /^[\d./–-]+\s*(?:(?:tbsp|tablespoons?|tsp|teaspoons?|cups?|grams?|g|kilograms?|kg|milliliters?|ml|liters?|litres?|l|oz|ounces?|lbs?|pounds?|pcs?|pieces?|cloves?|bunch(?:es)?|bottles?|cans?|packs?|slices?|stalks?|heads?|pinch(?:es)?|dash(?:es)?)\b|ช้อนโต๊ะ|ช้อนชา|กรัม|กิโลกรัม|ขีด|ถ้วย|ฟอง|หัว|กลีบ|ลูก|ต้น|ใบ|ลิตร|มิลลิลิตร|ဇွန်း|စားပွဲတင်ဇွန်း|လက်ဖက်ရည်ဇွန်း|ဂရမ်|ကီလို|လုံး|တောင့်|ပွင့်|ခွက်|လီတာ)?\s*(?:of\s+)?/i,
      ''
    )
    .trim();
}

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

// Non-blocking debounced disk writer (batches concurrent writes every 2s)
let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.warn('⚠️ Failed to write db.json:', e.message);
    }
  }, 2000);
}

function getTodayKey() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getSession(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      lang: 'auto', // 'auto' | 'en' | 'th' | 'my'
      pantryEditMode: null, // null | 'add' | 'delete'  (what the next typed message does)
      pantryBatchId: null, // which scanned-ingredient list is being edited
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
  if (!user.lang) user.lang = 'auto';
  // Migrate from the old single-flag edit mode
  if ('waitingForPantryEdit' in user) delete user.waitingForPantryEdit;
  if (user.pantryEditMode === undefined) user.pantryEditMode = null;
  if (user.pantryBatchId === undefined) user.pantryBatchId = null;
  if (!user.goals) user.goals = { calories: 2000, protein: 130, label: 'Balanced (2000 kcal)' };
  if (!Array.isArray(user.saved)) user.saved = [];
  const today = getTodayKey();
  if (!user.logs[today]) user.logs[today] = { calories: 0, protein: 0, meals: [] };
  return user;
}

// --- Pantry list editing helpers (add / delete) ---
function parseIngredientList(text = '') {
  return text
    .split(/[,;\n၊،、]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 60);
}

function normIngredient(s = '') {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function addIngredientsToList(list, requested) {
  const updated = [...list];
  const added = [];
  const skipped = [];
  for (const raw of requested) {
    const n = normIngredient(raw);
    if (!n) continue;
    if (updated.some((x) => normIngredient(x) === n)) {
      skipped.push(raw);
      continue;
    }
    if (updated.length >= 40) break;
    updated.push(raw);
    added.push(raw);
  }
  return { updated, added, skipped };
}

function removeIngredientsFromList(list, requested) {
  let updated = [...list];
  const removed = [];
  const notFound = [];
  for (const raw of requested) {
    const target = normIngredient(raw);
    if (!target) continue;
    const before = updated.length;
    updated = updated.filter((item) => {
      const n = normIngredient(item);
      if (n === target) return false;
      if (target.length >= 2 && n.includes(target)) return false; // "garlic" removes "garlic cloves"
      if (n.length >= 3 && target.includes(n)) return false; // "chicken breast fillet" removes "chicken breast"
      return true;
    });
    if (updated.length < before) removed.push(raw);
    else notFound.push(raw);
  }
  return { updated, removed, notFound };
}

// --- Stream 4: Verified B2B Partner Invite Codes ---
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
      const clean = stripLeadingMeasure(raw).toLowerCase();
      if (clean.length >= 2) {
        db.analytics.missingCounts[clean] = (db.analytics.missingCounts[clean] || 0) + 1;
      }
    }
  }
  saveDB();
}

// --- Stream 2: Multi-Partner Contextual Ad Pool ---
const PARTNER_AD_POOL = [
  {
    tags: ['protein', 'chicken', 'egg', 'beef', 'pork', 'salmon', 'fitness'],
    sponsor: 'Meiji High Protein (7-Eleven)',
    tagline: 'Meiji High Protein Milk (+28g P)',
    promoCode: 'FFMEIJI10 (10 THB Off at 7-Eleven)',
    url: 'https://www.7eleven.co.th/',
  },
  {
    tags: ['chicken', 'meat', 'budget', 'pork', 'fresh'],
    sponsor: 'CP FreshMart / Lotus’s Go Fresh',
    tagline: 'CP Fresh Chicken Packs — 25% Off',
    promoCode: 'FFCP25 (Show Barcode at Checkout)',
    url: 'https://www.lotuss.com/th',
  },
  {
    tags: ['thai', 'basil', 'garlic', 'soy', 'stir', 'oyster'],
    sponsor: 'Healthy Boy Brand (เด็กสมบูรณ์)',
    tagline: 'Healthy Boy Oyster & Soy Combo',
    promoCode: 'FFTHAI15 (15% Off on Shopee Mall)',
    url: 'https://shopee.co.th/search?keyword=healthy%20boy%20oyster%20sauce',
  },
  {
    tags: ['rice', 'noodle', 'quick', 'fry', 'spicy', 'chili'],
    sponsor: 'Maggi Thailand (แม็กกี้)',
    tagline: 'Maggi Cooking Sauce Pack (20฿ Off)',
    promoCode: 'FFMAGGI20 (20 THB Off at Tops)',
    url: 'https://www.tops.co.th/en/search/maggi',
  },
  {
    tags: ['egg', 'omelette', 'tomato', 'fried', 'kid', 'quick'],
    sponsor: 'Roza Lycopene (โรซ่า)',
    tagline: 'Roza Zero-Sugar Tomato Sauce',
    promoCode: 'FFROZA10 (Buy 1 Get 1 Mini Pack)',
    url: 'https://www.tops.co.th/en/search/roza',
  },
  {
    tags: ['salad', 'veggie', 'tofu', 'healthy', 'diet', 'low'],
    sponsor: 'Kewpie Thailand (คิวพี)',
    tagline: 'Kewpie Sesame Dressing (15% Off)',
    promoCode: 'FFKEWPIE15 (15% Off on Lazada)',
    url: 'https://www.lazada.co.th/catalog/?q=kewpie+sesame',
  },
  {
    tags: ['pasta', 'milk', 'cheese', 'butter', 'cream'],
    sponsor: 'Tops Online Express',
    tagline: 'Tops 1-Hr Dorm Delivery (50฿ Off)',
    promoCode: 'FFTOPS50 (50 THB Off First Order)',
    url: 'https://www.tops.co.th/en/',
  },
  {
    tags: ['all', 'student', 'budget', 'grocery'],
    sponsor: 'GrabMart Student Saver',
    tagline: 'GrabMart Free Delivery Near Campus',
    promoCode: 'FFGRABFREE (Free Delivery Near Campus)',
    url: 'https://food.grab.com/th/en/',
  },
  {
    tags: ['bulk', 'meal', 'prep', 'plan', '3-day'],
    sponsor: 'Makro PRO (แม็คโคร โปร)',
    tagline: 'Makro PRO Bulk Chicken & Eggs',
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

// --- Pure Node.js PNG Generator for Rich Menu ---
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

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  console.log('📩 Webhook hit! Events:', req.body.events.length);
  res.status(200).end();
  req.body.events.forEach((event) => {
    handleEvent(event).catch((err) =>
      console.error('❌ Error:', err?.status, err?.message, JSON.stringify(err?.errors || err?.body || ''))
    );
  });
});

async function getMessageBase64(messageId) {
  const stream = await blobClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('base64');
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

// Single-call sequential fallback (avoids 3x parallel RPM bursts so 70+ concurrent users run smoothly)
async function generateWithFallback(contents, config) {
  const models = await getAvailableModels();
  let lastErr;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await ai.models.generateContent({ model, contents, config });
      console.log(`✅ Winner: ${model}`);
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ ${model} failed (${err?.status || err?.message}), trying next...`);
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
    }
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
        backgroundColor: '#ECFDF5',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🍳 FRIDGEFRIEND AI', color: '#059669', size: 'xs', weight: 'bold' },
          { type: 'text', text: 'Your Smart Kitchen & Macro Chef', color: '#064E3B', size: 'lg', weight: 'bold', wrap: true },
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
          { type: 'text', text: '✍️ Type ingredients in any language', size: 'xs', color: '#374151', wrap: true },
          { type: 'text', text: '🌐 Type "burmese", "thai", or "english" to switch language', size: 'xs', color: '#059669', weight: 'bold', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'message', label: '🍗 Try Demo: Chicken & Garlic', text: 'chicken breast, garlic' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🌐 Change Language (TH/EN/MY)', data: 'action=lang_menu', displayText: '🌐 Change Language' } },
        ],
      },
    },
  };
}

function getFilterQuickReplies(session) {
  const lang = session?.lang || 'en';
  const langLabel = lang === 'th' ? '🇹🇭 ภาษาไทย' : lang === 'my' ? '🇲🇲 မြန်မာ' : lang === 'en' ? '🇬🇧 English' : '🌐 Language';

  return {
    items: [
      { type: 'action', action: { type: 'postback', label: langLabel, data: 'action=lang_menu', displayText: '🌐 Change Language (TH/EN/MY)' } },
      { type: 'action', action: { type: 'postback', label: '🏷️ 30% Flash Deal', data: 'action=flash_deal', displayText: '🏷️ Tonight’s Zero-Waste Flash Deal' } },
      { type: 'action', action: { type: 'postback', label: '💰 Under 60 THB', data: 'action=filter&style=budget_60', displayText: '💰 Budget meals under 60 THB' } },
      { type: 'action', action: { type: 'postback', label: '🗓️ 3-Day Plan', data: 'action=meal_plan', displayText: '🗓️ 3-Day Zero-Waste Meal Plan' } },
      { type: 'action', action: { type: 'postback', label: '💪 High Protein', data: 'action=filter&style=high_protein', displayText: '💪 High Protein options' } },
      { type: 'action', action: { type: 'postback', label: '🌶️ Thai Style', data: 'action=filter&style=thai_style', displayText: '🌶️ Thai Style options' } },
      { type: 'action', action: { type: 'message', label: '💼 B2B Revenue', text: 'revenue' } },
    ],
  };
}

// --- Pantry Verification Card Builder (shows the current working list) ---
function buildPantryVerificationCard(items, batchId, session) {
  const itemRows = items.length > 0
    ? items.map((item) => ({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'xs',
        contents: [
          { type: 'text', text: '🥬', size: 'sm', flex: 0 },
          { type: 'text', text: item, size: 'sm', color: '#1F2937', weight: 'bold', wrap: true, flex: 1 },
        ],
      }))
    : [{ type: 'text', text: t(session, 'emptyList'), size: 'sm', color: '#9CA3AF', margin: 'sm', wrap: true }];

  return {
    type: 'flex',
    altText: t(session, 'verifyTitle'),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#ECFDF5',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: t(session, 'verifyTitle'), color: '#059669', size: 'xs', weight: 'bold' },
          { type: 'text', text: t(session, 'verifySubtitle'), color: '#064E3B', size: 'sm', weight: 'bold', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: `${t(session, 'detected')}: ${items.length}`, size: 'xs', color: '#6B7280' },
          { type: 'separator', margin: 'sm' },
          ...itemRows,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#10B981',
            height: 'sm',
            action: { type: 'postback', label: t(session, 'confirmBtn'), data: `action=pantry_confirm&batch=${batchId}`, displayText: t(session, 'confirmBtn') },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: t(session, 'editBtn'), data: `action=pantry_edit&batch=${batchId}`, displayText: t(session, 'editBtn') },
          },
        ],
      },
    },
  };
}

// --- Pantry Edit Choice Card: Add or Delete ---
function buildPantryEditChoiceCard(batchId, session) {
  return {
    type: 'flex',
    altText: t(session, 'editChoiceTitle'),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#ECFDF5',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: t(session, 'editChoiceTitle'), color: '#059669', size: 'xs', weight: 'bold' },
          { type: 'text', text: t(session, 'editChoiceSubtitle'), color: '#064E3B', size: 'sm', weight: 'bold', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#10B981',
            height: 'sm',
            action: { type: 'postback', label: t(session, 'addBtn'), data: `action=pantry_mode&mode=add&batch=${batchId}`, displayText: t(session, 'addBtn') },
          },
          {
            type: 'button',
            style: 'primary',
            color: '#DC2626',
            height: 'sm',
            action: { type: 'postback', label: t(session, 'deleteBtn'), data: `action=pantry_mode&mode=delete&batch=${batchId}`, displayText: t(session, 'deleteBtn') },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: t(session, 'cancelBtn'), data: `action=pantry_cancel&batch=${batchId}`, displayText: t(session, 'cancelBtn') },
          },
        ],
      },
    },
  };
}

// --- Clean Executive Flex Card for 5-Stream B2B Business Model & Live Metrics ---
function buildB2BRevenueCard(session) {
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
    quickReply: getFilterQuickReplies(session),
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

// --- Multi-Theme Pastel Recipe Carousel (Fully Localized UI Buttons & Text) ---
function buildRecipeCarousel(recipes, session, includeQuickReplies = true, filterStyle = '') {
  const safeRecipes = Array.isArray(recipes) && recipes.length > 0
    ? recipes.slice(0, 5)
    : [{
        title: 'Thai Garlic Chicken Stir-Fry',
        emoji: '🍗',
        usedIngredients: ['200g chicken breast', '4 cloves garlic'],
        calories: 460,
        protein: 38,
        costThb: 45,
        time: '15m',
        allIngredients: [
          '200g chicken breast, thinly sliced',
          '4 cloves garlic, finely minced',
          '1 tbsp vegetable oil',
          '1 tbsp oyster sauce',
          '1 tbsp light soy sauce',
          '1/2 tsp sugar',
          '1/4 tsp ground white pepper',
          '2 tbsp water or stock',
          '1 cup warm jasmine rice',
        ],
        missingItems: [
          '1 tbsp vegetable oil',
          '1 tbsp oyster sauce',
          '1 tbsp light soy sauce',
          '1/2 tsp sugar',
          '1/4 tsp ground white pepper',
          '1 cup warm jasmine rice',
        ],
        steps: [
          'Prep: Slice 200g chicken breast into bite-sized strips across the grain and finely mince 4 cloves of garlic.',
          'Aromatics: Heat 1 tbsp vegetable oil in a wok or pan over medium-high heat. Add minced garlic and stir-fry for 30 seconds until golden and fragrant.',
          'Sear Protein: Add the sliced chicken breast in a single layer and stir-fry for 3 to 4 minutes until the outside turns opaque white.',
          'Season: Pour in 1 tbsp oyster sauce, 1 tbsp light soy sauce, 1/2 tsp sugar, and 2 tbsp water. Toss continuously for 2 minutes until the sauce glazes the chicken.',
          'Finish & Serve: Sprinkle with 1/4 tsp white pepper, plate over 1 cup of warm jasmine rice, and serve hot!',
        ],
      }];

  const cardThemes = [
    { headerBg: '#ECFDF5', tagColor: '#059669', titleColor: '#064E3B', barTrack: '#A7F3D0', barFill: '#10B981', btnColor: '#10B981' },
    { headerBg: '#EFF6FF', tagColor: '#2563EB', titleColor: '#1E3A8A', barTrack: '#BFDBFE', barFill: '#3B82F6', btnColor: '#2563EB' },
    { headerBg: '#FFF7ED', tagColor: '#EA580C', titleColor: '#7C2D12', barTrack: '#FED7AA', barFill: '#F97316', btnColor: '#EA580C' },
    { headerBg: '#F5F3FF', tagColor: '#7C3AED', titleColor: '#4C1D95', barTrack: '#DDD6FE', barFill: '#8B5CF6', btnColor: '#7C3AED' },
    { headerBg: '#FFF1F2', tagColor: '#E11D48', titleColor: '#881337', barTrack: '#FECDD3', barFill: '#F43F5E', btnColor: '#E11D48' },
  ];

  const enriched = safeRecipes.map((recipe) => {
    const allIngredients = Array.isArray(recipe.allIngredients) ? recipe.allIngredients.filter(Boolean) : [];
    const missing = Array.isArray(recipe.missingItems) && recipe.missingItems.length > 0
      ? recipe.missingItems.filter(Boolean)
      : ['None — ready!'];
    const hasMissing = missing.length > 0 && !/^(none|ไม่มี|မရှိ)/i.test(missing[0].trim());
    const usedCount = Array.isArray(recipe.usedIngredients) && recipe.usedIngredients.length > 0
      ? recipe.usedIngredients.length
      : Math.max(1, allIngredients.length - (hasMissing ? missing.length : 0));
    const totalCount = Math.max(allIngredients.length, usedCount + (hasMissing ? missing.length : 0), 1);
    const matchPct = hasMissing
      ? Math.max(35, Math.min(95, Math.round(((totalCount - missing.length) / totalCount) * 100)))
      : 100;
    return { ...recipe, allIngredients, missing, hasMissing, matchPct };
  }).sort((a, b) => b.matchPct - a.matchPct);

  const usedSponsors = new Set();
  const bubbles = [];

  for (let idx = 0; idx < enriched.length; idx++) {
    const recipe = enriched[idx];
    const theme = cardThemes[idx % cardThemes.length];
    const recipeId = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1000)}`;
    const title = (recipe.title || 'Quick Fridge Dish').slice(0, 52);
    const time = (recipe.time || '15m').replace(/\s*total/i, '');
    const calories = Number(recipe.calories) || 450;
    const protein = Number(recipe.protein) || 32;
    const costThb = Number(recipe.costThb) || 45;
    const { allIngredients, missing, hasMissing, matchPct } = recipe;

    const usedList = Array.isArray(recipe.usedIngredients) && recipe.usedIngredients.length > 0
      ? recipe.usedIngredients.slice(0, 4).join(', ')
      : allIngredients.slice(0, 4).join(', ') || 'Your fridge ingredients';

    const steps = Array.isArray(recipe.steps) && recipe.steps.length > 0
      ? recipe.steps
      : ['Prep your ingredients.', 'Cook over medium heat until done.', 'Season to taste and serve!'];

    recordPantryTrends('', missing);

    const sponsor = getContextualSponsor(`${title} ${recipe.mainIngredient || ''}`, filterStyle, usedSponsors);
    const normalizedRecipe = {
      ...recipe,
      id: recipeId,
      title,
      time,
      calories,
      protein,
      costThb,
      macros: `${calories} kcal | ${protein}g P`,
      usedIngredients: Array.isArray(recipe.usedIngredients) ? recipe.usedIngredients : [],
      allIngredients,
      missingItems: missing,
      steps,
      sponsor,
    };
    recipeStore.set(recipeId, normalizedRecipe);

    const topTag = idx === 0 ? t(session, 'bestMatch') : `${t(session, 'option')} #${idx + 1}`;
    // Safely strip leading quantities/units using word-boundary helper so "2 liters water" -> "water" (never "iters water")
    const missingCleanNames = missing
      .slice(0, 4)
      .map((m) => stripLeadingMeasure(m))
      .join(', ');

    bubbles.push({
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: theme.headerBg,
        height: '128px',
        paddingAll: 'lg',
        justifyContent: 'space-between',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              { type: 'text', text: topTag, color: theme.tagColor, size: 'xs', weight: 'bold', flex: 3 },
              { type: 'text', text: `⏱️ ${time}`, color: theme.tagColor, size: 'xs', weight: 'bold', align: 'end', flex: 2 },
            ],
          },
          {
            type: 'text',
            text: `${recipe.emoji || '🍳'} ${title}`,
            color: theme.titleColor,
            size: 'md',
            weight: 'bold',
            wrap: true,
            maxLines: 2,
          },
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: theme.barTrack,
                height: '6px',
                cornerRadius: 'md',
                flex: 3,
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: theme.barFill,
                    height: '6px',
                    width: `${matchPct}%`,
                    cornerRadius: 'md',
                    contents: [],
                  },
                ],
              },
              { type: 'text', text: `${matchPct}% Match`, color: theme.tagColor, size: 'xs', weight: 'bold', align: 'end', flex: 2 },
            ],
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        height: '264px',
        paddingAll: 'xl',
        justifyContent: 'space-between',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F8FAFC',
                cornerRadius: 'md',
                paddingAll: 'md',
                flex: 1,
                contents: [
                  { type: 'text', text: `🔥 ${calories}`, size: 'sm', color: '#1E293B', align: 'center', weight: 'bold' },
                  { type: 'text', text: 'kcal', size: 'xxs', color: '#64748B', align: 'center' },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F8FAFC',
                cornerRadius: 'md',
                paddingAll: 'md',
                flex: 1,
                contents: [
                  { type: 'text', text: `💪 ${protein}g`, size: 'sm', color: theme.tagColor, align: 'center', weight: 'bold' },
                  { type: 'text', text: 'protein', size: 'xxs', color: '#64748B', align: 'center' },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F8FAFC',
                cornerRadius: 'md',
                paddingAll: 'md',
                flex: 1,
                contents: [
                  { type: 'text', text: `💵 ~${costThb}฿`, size: 'sm', color: '#1E293B', align: 'center', weight: 'bold' },
                  { type: 'text', text: 'cost', size: 'xxs', color: '#64748B', align: 'center' },
                ],
              },
            ],
          },
          {
            type: 'box',
            layout: 'vertical',
            height: '80px',
            justifyContent: 'center',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: `${t(session, 'uses')}: ${usedList}`,
                size: 'xs',
                color: '#1F2937',
                weight: 'bold',
                wrap: true,
                maxLines: 2,
              },
              {
                type: 'text',
                text: hasMissing
                  ? `${t(session, 'need')} (${missing.length} ${t(session, 'itemsUnit')}): ${missingCleanNames}${missing.length > 4 ? '...' : ''}`
                  : t(session, 'readyCook'),
                size: 'xs',
                color: hasMissing ? '#DC2626' : '#059669',
                wrap: true,
                maxLines: 2,
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#FFFBEB',
            cornerRadius: 'md',
            height: '48px',
            alignItems: 'center',
            paddingStart: 'md',
            paddingEnd: 'md',
            spacing: 'sm',
            action: {
              type: 'postback',
              label: 'Partner Offer',
              data: `action=sponsor_click&id=${recipeId}`,
              displayText: `🏷️ ${sponsor.sponsor} Deal`,
            },
            contents: [
              {
                type: 'text',
                text: `Ad • ${sponsor.tagline}`,
                size: 'xs',
                color: '#B45309',
                weight: 'bold',
                wrap: true,
                flex: 1,
              },
              {
                type: 'text',
                text: '↗',
                size: 'sm',
                color: '#D97706',
                weight: 'bold',
                flex: 0,
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        paddingTop: 'none',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: theme.btnColor,
            height: 'sm',
            action: { type: 'postback', label: t(session, 'cookBtn'), data: `action=cook&id=${recipeId}&step=0`, displayText: `Start cooking ${title}`.slice(0, 300) },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                flex: 1,
                action: { type: 'postback', label: hasMissing ? `${t(session, 'buyBtn')} (${missing.length})` : `${t(session, 'readyBtn')} (0)`, data: `action=missing&id=${recipeId}`, displayText: `Order missing items for ${title}`.slice(0, 300) },
              },
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                flex: 1,
                action: { type: 'postback', label: t(session, 'saveBtn'), data: `action=save&id=${recipeId}`, displayText: `Save ${title}`.slice(0, 300) },
              },
            ],
          },
        ],
      },
    });
  }

  const msg = { type: 'flex', altText: 'FridgeFriend Recipe Suggestions 🍳', contents: { type: 'carousel', contents: bubbles } };
  if (includeQuickReplies) msg.quickReply = getFilterQuickReplies(session);
  return msg;
}

function buildMealPlanCarousel(planData, session) {
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
      backgroundColor: '#ECFDF5',
      paddingAll: 'md',
      contents: [
        { type: 'text', text: `🗓️ DAY ${idx + 1} MEAL PREP`, color: '#059669', size: 'xs', weight: 'bold' },
        { type: 'text', text: d.focus || 'Zero-Waste Balanced Day', color: '#064E3B', size: 'md', weight: 'bold', wrap: true },
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
      contents: [{ type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: `🛒 Buy 3-Day Groceries (${finalShoppingList.length})`, data: `action=plan_list&id=${planId}`, displayText: 'Show 3-Day Consolidated Shopping List 🛒' } }],
    },
  }));

  return { type: 'flex', altText: '🗓️ 3-Day Zero-Waste Meal Plan', contents: { type: 'carousel', contents: dayBubbles }, quickReply: getFilterQuickReplies(session) };
}

// --- Enhanced Cook Mode Card (Shows Full Ingredient + Missing Breakdown on Step 1) ---
function buildSingleStepCard(recipe, stepIndex, session) {
  const total = recipe.steps.length;
  const currentStep = recipe.steps[stepIndex] || 'Enjoy your meal!';
  const isLast = stepIndex >= total - 1;
  const timeMatch = currentStep.match(/(\d+)\s*(?:minute|minutes|min|mins|m|นาที|မိနစ်)\b/i);
  const detectedMinutes = timeMatch ? Math.min(parseInt(timeMatch[1], 10), 60) : null;
  const footerButtons = [];

  if (detectedMinutes && detectedMinutes > 0) {
    footerButtons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: `${t(session, 'setTimerBtn')} (${detectedMinutes} ${t(session, 'minsUnit')})`,
        data: `action=timer&mins=${detectedMinutes}&title=${encodeURIComponent(recipe.title)}`,
        displayText: `Set ${detectedMinutes}-minute timer ⏱️`,
      },
    });
  }
  if (!isLast) {
    footerButtons.push({
      type: 'button',
      style: 'primary',
      color: '#10B981',
      height: 'sm',
      action: {
        type: 'postback',
        label: `${t(session, 'nextStepBtn')} (${stepIndex + 2}/${total}) ➡️`,
        data: `action=cook&id=${recipe.id}&step=${stepIndex + 1}`,
        displayText: `${t(session, 'stepTitle')} ${stepIndex + 2}`,
      },
    });
  } else {
    footerButtons.push({
      type: 'button',
      style: 'primary',
      color: '#059669',
      height: 'sm',
      action: {
        type: 'postback',
        label: `${t(session, 'cookedBtn')} (+${recipe.protein}g P)`,
        data: `action=log_meal&id=${recipe.id}`,
        displayText: `Logged ${recipe.title}! 💪`,
      },
    });
  }

  const hasMissing = Array.isArray(recipe.missingItems) && recipe.missingItems.length > 0 && !/^(none|ไม่มี|မရှိ)/i.test(recipe.missingItems[0] || '');
  const prepCheck = stepIndex === 0 && Array.isArray(recipe.allIngredients) && recipe.allIngredients.length > 0
    ? [
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#F8FAFC',
          cornerRadius: 'md',
          paddingAll: 'md',
          spacing: 'xs',
          contents: [
            { type: 'text', text: t(session, 'prepCheck'), size: 'xs', weight: 'bold', color: '#0F172A' },
            ...recipe.allIngredients.map((ing) => ({
              type: 'text',
              text: `• ${ing}`,
              size: 'xs',
              color: '#334155',
              wrap: true,
            })),
            ...(hasMissing
              ? [
                  { type: 'separator', margin: 'sm' },
                  {
                    type: 'text',
                    text: `${t(session, 'needPrefix')} (${recipe.missingItems.length}): ${recipe.missingItems.join(', ')}`,
                    size: 'xxs',
                    color: '#DC2626',
                    weight: 'bold',
                    wrap: true,
                    margin: 'xs',
                  },
                ]
              : []),
          ],
        },
      ]
    : [];

  return {
    type: 'flex',
    altText: `${t(session, 'stepTitle')} ${stepIndex + 1}/${total}: ${recipe.title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `${t(session, 'stepTitle')} ${stepIndex + 1} ${t(session, 'of')} ${total}`, weight: 'bold', size: 'xs', color: '#10B981' },
          { type: 'text', text: `${recipe.emoji || '🍳'} ${recipe.title}`, weight: 'bold', size: 'md', wrap: true },
          ...prepCheck,
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
        contents: [{ type: 'text', text: `🏋️ Partner: ${session.gymPartner}`, size: 'xs', weight: 'bold', color: '#1D4ED8', align: 'center', wrap: true }],
      }]
    : [];

  const mealLines = log.meals.length > 0
    ? log.meals.map((m) => ({ type: 'text', text: `• ${m.title} (${m.calories} kcal, ${m.protein}g P)`, size: 'xs', color: '#4B5563', wrap: true }))
    : [{ type: 'text', text: 'No meals cooked yet today!', size: 'xs', color: '#9CA3AF', wrap: true }];

  return {
    type: 'flex',
    altText: t(session, 'dailyMacros'),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `${t(session, 'dailyMacros')} (${today})`, weight: 'bold', size: 'lg', color: '#111827' },
          ...gymSection,
          { type: 'text', text: `${t(session, 'target')}: ${session.goals.label || `${calGoal} kcal | ${proGoal}g P`}`, size: 'xs', color: '#059669', weight: 'bold' },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: `💪 ${t(session, 'protein')}: ${log.protein}g / ${proGoal}g (${proPct}%)`, size: 'sm', weight: 'bold', color: '#047857' },
              { type: 'box', layout: 'vertical', backgroundColor: '#E5E7EB', height: '8px', cornerRadius: 'md', contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#10B981', height: '8px', width: `${Math.max(proPct, 4)}%`, cornerRadius: 'md', contents: [] }] },
            ],
          },
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              { type: 'text', text: `🔥 ${t(session, 'calories')}: ${log.calories} / ${calGoal} kcal (${calPct}%)`, size: 'sm', weight: 'bold', color: '#B45309' },
              { type: 'box', layout: 'vertical', backgroundColor: '#E5E7EB', height: '8px', cornerRadius: 'md', contents: [{ type: 'box', layout: 'vertical', backgroundColor: '#F59E0B', height: '8px', width: `${Math.max(calPct, 4)}%`, cornerRadius: 'md', contents: [] }] },
            ],
          },
          { type: 'separator' },
          { type: 'text', text: t(session, 'mealsLogged'), size: 'xs', weight: 'bold', color: '#374151' },
          ...mealLines,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '⚙️ Customize Targets', data: 'action=goal_menu', displayText: '⚙️ Customize Daily Goals' } },
        ],
      },
    },
    quickReply: getFilterQuickReplies(session),
  };
}

function buildGoalPickerCard(session) {
  return {
    type: 'flex',
    altText: '⚙️ Set Daily Targets',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '⚙️ Set Your Daily Targets', weight: 'bold', size: 'lg', color: '#111827' },
          { type: 'text', text: `Current: ${session.goals.calories} kcal | ${session.goals.protein}g protein`, size: 'xs', color: '#4B5563', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'xs',
        contents: [
          { type: 'button', style: 'primary', color: '#059669', height: 'sm', action: { type: 'postback', label: '💪 Lean Bulk (2500 kcal | 150g P)', data: 'action=set_goal&cal=2500&pro=150&label=Lean+Bulk', displayText: 'Set goal: Lean Bulk' } },
          { type: 'button', style: 'primary', color: '#10B981', height: 'sm', action: { type: 'postback', label: '⚖️ Maintain (2000 kcal | 120g P)', data: 'action=set_goal&cal=2000&pro=120&label=Maintain', displayText: 'Set goal: Maintain' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '🥗 Fat Loss / Cut (1650 kcal | 135g P)', data: 'action=set_goal&cal=1650&pro=135&label=Fat+Loss+Cut', displayText: 'Set goal: Fat Loss / Cut' } },
        ],
      },
    },
  };
}

function buildShoppingListCard(title, items, allIngredients = [], session = null) {
  const hasRealMissing = Array.isArray(items) && items.length > 0 && !/^(none|ไม่มี|မရှိ)/i.test(items[0] || '');
  const missingRows = hasRealMissing
    ? items.map((item) => ({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: '🛒', size: 'sm', flex: 0 },
          { type: 'text', text: item, size: 'sm', color: '#DC2626', weight: 'bold', wrap: true, flex: 1 },
        ],
      }))
    : [{ type: 'text', text: t(session, 'readyCook'), size: 'sm', color: '#059669', weight: 'bold', margin: 'sm', wrap: true }];

  const fullListSection = Array.isArray(allIngredients) && allIngredients.length > 0
    ? [
        { type: 'separator', margin: 'md' },
        { type: 'text', text: t(session, 'fullRecipeHeader'), size: 'xs', weight: 'bold', color: '#374151', margin: 'md', wrap: true },
        ...allIngredients.map((ing) => ({ type: 'text', text: `• ${ing}`, size: 'xs', color: '#4B5563', wrap: true })),
      ]
    : [];

  const firstCleanItem = stripLeadingMeasure(items[0] || 'groceries');
  const query = encodeURIComponent(firstCleanItem || 'chicken');

  return {
    type: 'flex',
    altText: `Shopping List: ${title}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: `${t(session, 'missingHeader')} (${hasRealMissing ? items.length : 0})`, weight: 'bold', size: 'md', color: '#10B981', wrap: true },
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

// --- Gemini AI Generators (Pure Single-Language Output + Complete Ingredients Audit + 5–6 Detailed Steps) ---
async function generateRecipesForSession(session, filterStyle = null) {
  const styleInstructions = {
    budget_60: 'Focus strictly on STUDENT BUDGET-FRIENDLY meals costing UNDER 60 THB per serving.',
    high_protein: 'Focus strictly on HIGH-PROTEIN fitness meals (40g+ protein).',
    quick_15m: 'Focus strictly on ULTRA-FAST meals ready in 15 MINUTES OR LESS.',
    thai_style: 'Focus strictly on authentic THAI-STYLE dishes.',
  };
  const extraRule = filterStyle && styleInstructions[filterStyle] ? styleInstructions[filterStyle] : '';

  const langInstructions = {
    th: `LANGUAGE RULE (CRITICAL — 100% THAI ONLY):
- Write ALL output fields ("title", "time", "usedIngredients", "allIngredients", "missingItems", and "steps") strictly in 100% natural culinary THAI (ภาษาไทยล้วน เช่น ช้อนโต๊ะ, ช้อนชา, กรัม, ซีอิ๊วขาว, ซอสหอยนางรม, น้ำปลา, น้ำตาลทราย, พริกไทยป่น, ข้าวสวยร้อนๆ).
- Even if the user's input ingredients are written in English or Burmese, TRANSLATE every ingredient name into Thai. NEVER include Burmese or English words in parentheses.`,
    en: `LANGUAGE RULE (CRITICAL — 100% ENGLISH ONLY):
- Write ALL output fields ("title", "time", "usedIngredients", "allIngredients", "missingItems", and "steps") strictly in 100% pure ENGLISH.
- Even if the user's input ingredients are written in Burmese or Thai, TRANSLATE every single ingredient name into plain English (e.g., write "500g beef bones", NEVER write "500g အမဲရိုး (beef bones)"). Do NOT include any Burmese or Thai characters anywhere in the JSON.`,
    my: `LANGUAGE RULE (CRITICAL — 100% BURMESE ONLY & NEVER USE "အမယ်"):
- Write ALL output fields ("title", "time", "usedIngredients", "allIngredients", "missingItems", and "steps") strictly in 100% natural, fluent Myanmar language (မြန်မာဘာသာသီးသန့်ဖြင့် ရေးပါ — ဥပမာ စားပွဲတင်ဇွန်း၊ လက်ဖက်ရည်ဇွန်း၊ ဂရမ်၊ ပဲငံပြာရည်အကြည်၊ ခရုဆီ၊ ငံပြာရည်၊ ဆား၊ သကြား၊ ဟင်းချက်ဆီ၊ ကြက်သွန်ဖြူ၊ ကြက်သွန်နီ၊ ထမင်းပူပူ).
- NEVER use the word "အမယ်" anywhere — use "ပါဝင်ပစ္စည်း" or the specific food name instead.
- Even if the user's input ingredients are written in English or Thai, TRANSLATE every ingredient name into natural Burmese without English words in parentheses.`,
    auto: `LANGUAGE RULE (CRITICAL — AUTO-DETECT SINGLE LANGUAGE):
- Detect the language of the user's input (Burmese မြန်မာဘာသာ, Thai ภาษาไทย, or English) and write ALL output fields ("title", "time", "usedIngredients", "allIngredients", "missingItems", and "steps") 100% in THAT SINGLE LANGUAGE (do not mix languages or put translations in parentheses). If Burmese, never use the word "အမယ်" (use "ပါဝင်ပစ္စည်း").`,
  };
  const chosenLangRule = langInstructions[session.lang] || langInstructions.auto;

  const schemaPrompt = `${extraRule}
${chosenLangRule}
- ALWAYS keep "mainIngredient" in lowercase ENGLISH (e.g., "chicken", "pork", "egg", "beef", "tofu", "shrimp", "noodle").

CRITICAL INGREDIENT & MISSING-ITEM AUDIT RULES (DO NOT SKIP ANY ITEM):
1. "allIngredients": Must list EVERY SINGLE ingredient required to actually cook the dish so it tastes complete and authentic (6 to 10 items with exact measurements, e.g., main protein, vegetables, aromatics like garlic/shallots/chili/ginger, cooking oil, sauces like soy sauce/fish sauce/oyster sauce, sugar/salt/pepper, water/stock, and rice/noodles if served with it).
2. "usedIngredients": List ONLY the ingredients from the user's provided list/photo that are used in this recipe (translated into the target output language with measurements).
3. "missingItems": Strictly compare "allIngredients" against ONLY what the user explicitly provided. Put EVERY SINGLE required ingredient that the user did NOT explicitly mention (including cooking oil, sauces, seasonings, sugar, salt, pepper, garlic, onion, chili, herbs, stock, and rice/noodles) inside "missingItems" with exact quantities! Never return only 1 missing item when the recipe also needs oil, sauces, seasonings, or aromatics that the user did not list.

CRITICAL STEP-BY-STEP COOKING INSTRUCTIONS RULE:
- "steps": Must contain 5 to 6 complete, detailed, foolproof cooking steps so even a beginner can cook the dish from start to finish!
- Step 1: Exact prep & cutting instructions (how to slice meat, mince aromatics, wash/cut veggies, or whisk sauces) with quantities.
- Step 2: Heating the pan/wok (heat level + amount of oil) and sautéing aromatics with exact time and visual/aroma cue (e.g., "for 30–45 seconds until golden and fragrant").
- Step 3: Cooking the main protein or base ingredient with exact minutes and doneness cue.
- Step 4: Adding vegetables, liquids/stock, and exact measurements of every sauce/seasoning.
- Step 5: Simmering/tossing/reducing the sauce, taste adjustment, and final garnish/plating instructions.

Return ONLY valid JSON (no markdown) matching this exact structure:
{
  "recipes": [
    {
      "title": "Dish Name",
      "emoji": "🍗",
      "mainIngredient": "chicken",
      "usedIngredients": ["200g chicken breast", "4 cloves garlic"],
      "calories": 520,
      "protein": 44,
      "costThb": 48,
      "time": "15m",
      "allIngredients": [
        "200g chicken breast, thinly sliced",
        "4 cloves garlic, finely minced",
        "1 tbsp cooking oil",
        "1 tbsp oyster sauce",
        "1 tbsp light soy sauce",
        "1 tsp fish sauce",
        "1/2 tsp sugar",
        "1/4 tsp ground white pepper",
        "2 tbsp water",
        "1 cup steamed jasmine rice"
      ],
      "missingItems": [
        "1 tbsp cooking oil",
        "1 tbsp oyster sauce",
        "1 tbsp light soy sauce",
        "1 tsp fish sauce",
        "1/2 tsp sugar",
        "1/4 tsp ground white pepper",
        "1 cup steamed jasmine rice"
      ],
      "steps": [
        "Step 1 (Prep): Slice 200g chicken breast into thin bite-sized pieces and finely mince 4 cloves of garlic.",
        "Step 2 (Aromatics): Heat 1 tbsp cooking oil in a pan over medium-high heat. Add the minced garlic and stir-fry for 30 seconds until golden and fragrant.",
        "Step 3 (Protein): Add the sliced chicken breast and stir-fry for 3–4 minutes until the meat turns white and is 80% cooked through.",
        "Step 4 (Seasoning): Add 1 tbsp oyster sauce, 1 tbsp light soy sauce, 1 tsp fish sauce, 1/2 tsp sugar, and 2 tbsp water. Toss over high heat for 2 minutes until the sauce coats the chicken evenly.",
        "Step 5 (Serve): Turn off the heat, sprinkle with 1/4 tsp ground white pepper, and serve hot over 1 cup of steamed jasmine rice."
      ]
    }
  ]
}
Suggest 3 distinct, practical, delicious recipes.`;

  const geminiContents = session.lastPromptType === 'image' && session.lastImageBase64
    ? [{ inlineData: { mimeType: 'image/jpeg', data: session.lastImageBase64 } }, `You are FridgeFriend, a master chef. Identify ONLY the ingredients visible in this photo and suggest 3 complete recipes. ${schemaPrompt}`]
    : `You are FridgeFriend, a master chef. The user ONLY has these exact ingredients: "${session.lastText}". Assume they do NOT have any other ingredients unless listed in "missingItems". ${schemaPrompt}`;

  const response = await generateWithFallback(geminiContents, { responseMimeType: 'application/json' });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
  const recipeList = Array.isArray(parsed) ? parsed : (parsed.recipes || parsed.meals || Object.values(parsed).find(Array.isArray) || []);
  return buildRecipeCarousel(recipeList, session, true, filterStyle || '');
}

async function generateMealPlanForSession(session) {
  const langInstructions = {
    th: 'Write the entire meal plan strictly in 100% natural THAI (ภาษาไทยล้วน). Translate all ingredient names into Thai.',
    en: 'Write the entire meal plan strictly in 100% pure ENGLISH. Translate all ingredient names into English.',
    my: 'Write the entire meal plan strictly in 100% natural, fluent BURMESE (မြန်မာဘာသာသီးသန့်). Never use the word "အမယ်" (use "ပါဝင်ပစ္စည်း").',
    auto: 'Match the user\'s input language (Burmese, Thai, or English) or default to English.',
  };

  const planPrompt = `Create a smart 3-Day Zero-Waste Meal Plan (6 meals total). ${langInstructions[session.lang] || ''}
Include ALL required groceries, sauces, seasonings, and staples inside "ingredientsNeeded" and "consolidatedShoppingList" with exact quantities.
Return ONLY valid JSON (no markdown) matching this exact format:
{
  "days": [
    {
      "focus": "Use Fresh Meat First",
      "lunch": "Dish Name",
      "lunchMacros": "480 kcal | 40g P",
      "dinner": "Dish Name",
      "dinnerMacros": "520 kcal | 42g P",
      "ingredientsNeeded": ["300g chicken breast", "4 cloves garlic", "2 tbsp soy sauce", "1 tbsp oyster sauce", "2 cups jasmine rice"],
      "wasteTip": "Tip on leftovers"
    }
  ],
  "consolidatedShoppingList": ["600g chicken breast", "6 eggs", "1 head garlic", "1 bottle light soy sauce", "1 bottle oyster sauce", "1 bottle cooking oil", "1kg jasmine rice"]
}`;

  const geminiContents = session.lastPromptType === 'image' && session.lastImageBase64
    ? [{ inlineData: { mimeType: 'image/jpeg', data: session.lastImageBase64 } }, `Create a 3-day meal plan from this photo. ${planPrompt}`]
    : `Create a 3-day meal plan based on: "${session.lastText || 'chicken breast, eggs, garlic, rice'}". ${planPrompt}`;

  const response = await generateWithFallback(geminiContents, { responseMimeType: 'application/json' });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
  const normalizedPlan = Array.isArray(parsed) ? { days: parsed } : parsed;
  return buildMealPlanCarousel(normalizedPlan, session);
}

// --- Webhook Event Handler ---
async function handleEvent(event) {
  const userId = event.source?.userId || 'default_user';
  const session = getSession(userId);

  if (event.type === 'follow') {
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
  }

  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'lang_menu') {
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: '🌐 Choose your preferred language / ဘာသာစကား ရွေးချယ်ပါ / เลือกภาษา:',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'postback', label: '🇲🇲 မြန်မာ (Burmese)', data: 'action=set_lang&lang=my', displayText: '🇲🇲 မြန်မာဘာသာသို့ ပြောင်းမည်' } },
              { type: 'action', action: { type: 'postback', label: '🇹🇭 ภาษาไทย (Thai)', data: 'action=set_lang&lang=th', displayText: '🇹🇭 เปลี่ยนเป็นภาษาไทย' } },
              { type: 'action', action: { type: 'postback', label: '🇬🇧 English', data: 'action=set_lang&lang=en', displayText: '🇬🇧 Switch to English' } },
              { type: 'action', action: { type: 'postback', label: '✨ Auto-Detect', data: 'action=set_lang&lang=auto', displayText: '✨ Auto-Detect Language' } },
            ],
          },
        }],
      });
    }

    if (action === 'set_lang') {
      const lang = params.get('lang') || 'auto';
      session.lang = lang;
      saveDB();
      const confirmMap = {
        th: '✅ ตั้งค่าเป็นภาษาไทยเรียบร้อย! เมนูและปุ่มทั้งหมดเปลี่ยนเป็นภาษาไทยแล้ว 🍳',
        en: '✅ Language set to English! All buttons & menus are now in English 🍳',
        my: '✅ မြန်မာဘာသာသို့ ပြောင်းလဲပြီးပါပြီ! ခလုတ်များနှင့် ဟင်းချက်နည်းအားလုံး မြန်မာလို ပြသပေးပါမည် 🍳',
        auto: '✅ Auto-detect enabled! 🌐',
      };
      if (session.lastPromptType) {
        if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
        const carousel = await generateRecipesForSession(session);
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: confirmMap[lang] }, carousel] });
      }
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: confirmMap[lang] }] });
    }

    // --- Pantry Verification: Confirm (Sends status text immediately, then pushes recipes) ---
    if (action === 'pantry_confirm') {
      const batchId = params.get('batch');
      const items = pendingPantryItems.get(batchId);
      session.pantryEditMode = null;
      session.pantryBatchId = null;

      if (!items) {
        saveDB();
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      }
      if (items.length === 0) {
        saveDB();
        return messagingClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: t(session, 'emptyConfirm') }, buildPantryVerificationCard(items, batchId, session)],
        });
      }

      session.lastPromptType = 'text';
      session.lastText = items.join(', ');
      session.lastImageBase64 = null;
      recordPantryTrends(session.lastText, []);
      saveDB();

      const targetUserId = event.source?.userId;
      if (targetUserId) {
        // 1. Reply immediately so "Finding delicious recipes..." appears right away
        await messagingClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: t(session, 'confirmedHeader') }],
        });
        messagingClient.showLoadingAnimation({ chatId: targetUserId, loadingSeconds: 10 }).catch(() => {});

        // 2. Generate recipes and push the carousel as soon as Gemini finishes
        const carousel = await generateRecipesForSession(session);
        return messagingClient.pushMessage({
          to: targetUserId,
          messages: [carousel],
        });
      }

      // Fallback if userId is unavailable
      const carousel = await generateRecipesForSession(session);
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: t(session, 'confirmedHeader') }, carousel],
      });
    }

    // --- Pantry Verification: Edit -> ask Add or Delete ---
    if (action === 'pantry_edit') {
      const batchId = params.get('batch');
      if (!pendingPantryItems.has(batchId)) {
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      }
      session.pantryEditMode = null; // wait for the user to choose Add or Delete
      session.pantryBatchId = batchId;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildPantryEditChoiceCard(batchId, session)],
      });
    }

    // --- Pantry Edit: user chose Add or Delete ---
    if (action === 'pantry_mode') {
      const batchId = params.get('batch');
      const mode = params.get('mode') === 'delete' ? 'delete' : 'add';
      if (!pendingPantryItems.has(batchId)) {
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      }
      session.pantryEditMode = mode;
      session.pantryBatchId = batchId;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: t(session, mode === 'add' ? 'addPrompt' : 'deletePrompt'),
          quickReply: {
            items: [
              { type: 'action', action: { type: 'postback', label: t(session, 'cancelBtn').slice(0, 20), data: `action=pantry_cancel&batch=${batchId}`, displayText: t(session, 'cancelBtn') } },
            ],
          },
        }],
      });
    }

    // --- Pantry Edit: cancel -> show the list again ---
    if (action === 'pantry_cancel') {
      const batchId = params.get('batch');
      session.pantryEditMode = null;
      saveDB();
      const items = pendingPantryItems.get(batchId);
      if (!items) {
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      }
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildPantryVerificationCard(items, batchId, session)] });
    }

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
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildFlashDealCard()] });
    }

    if (action === 'cook') {
      const recipe = recipeStore.get(params.get('id'));
      const stepIdx = parseInt(params.get('step') || '0', 10);
      if (!recipe) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildSingleStepCard(recipe, stepIdx, session)] });
    }

    if (action === 'timer') {
      const mins = parseInt(params.get('mins') || '5', 10);
      const dishTitle = params.get('title') || 'your dish';
      setTimeout(() => {
        if (event.source?.userId) {
          messagingClient.pushMessage({ to: event.source.userId, messages: [{ type: 'text', text: `⏰ Ding! Your ${mins}-minute timer for ${dishTitle} is up! 🔥🍳` }] }).catch((e) => console.error('Timer push failed:', e.message));
        }
      }, mins * 60 * 1000);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `⏱️ Timer set for ${mins} minute(s)!` }] });
    }

    if (action === 'missing') {
      const recipe = recipeStore.get(params.get('id'));
      if (!recipe) return null;
      db.analytics.affiliateClicks = (db.analytics.affiliateClicks || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildShoppingListCard(recipe.title, recipe.missingItems, recipe.allIngredients, session)],
      });
    }

    if (action === 'plan_list') {
      const items = mealPlanStore.get(params.get('id')) || ['Chicken breast, eggs, garlic, rice'];
      db.analytics.affiliateClicks = (db.analytics.affiliateClicks || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [buildShoppingListCard('3-Day Meal Prep Ingredients', items, [], session)],
      });
    }

    if (action === 'save') {
      const recipe = recipeStore.get(params.get('id'));
      if (!recipe) return null;
      if (!session.saved.some((r) => r.title === recipe.title)) { session.saved.push(recipe); saveDB(); }
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `❤️ Saved "${recipe.title}" to My Cookbook! (${session.saved.length} saved)`,
          quickReply: getFilterQuickReplies(session),
        }],
      });
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
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `✅ Updated daily target to ${cal} kcal & ${pro}g protein!` }, buildStatsCard(session)] });
    }

    if (action === 'receipt_cook') {
      const items = pendingReceiptItems.get(params.get('batch')) || [];
      if (items.length === 0) return null;
      session.lastPromptType = 'text';
      session.lastText = items.join(', ');
      recordPantryTrends(session.lastText, []);
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const carousel = await generateRecipesForSession(session);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🍳 Cooking with your ${items.length} scanned receipt items:` }, carousel] });
    }

    if (action === 'meal_plan') {
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const planCarousel = await generateMealPlanForSession(session);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [planCarousel] });
    }

    if (action === 'filter') {
      if (!session.lastPromptType) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: 'Send ingredients or a fridge photo first! 🥦📸' }] });
      if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
      const carousel = await generateRecipesForSession(session, params.get('style'));
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [carousel] });
    }
  }

  if (event.type !== 'message') return null;

  if (event.message.type === 'text') {
    const rawText = event.message.text.trim();
    const lower = rawText.toLowerCase();

    // --- Pantry list editing: the typed message ADDS to or DELETES from the scanned list ---
    if (session.pantryEditMode && session.pantryBatchId) {
      const mode = session.pantryEditMode;
      const batchId = session.pantryBatchId;
      session.pantryEditMode = null; // one edit per Add/Delete choice, then show the list again
      saveDB();

      const current = pendingPantryItems.get(batchId);
      if (!current) {
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: t(session, 'expired') }] });
      }

      const requested = parseIngredientList(rawText);
      let updated = current;
      const summary = [];

      if (mode === 'add') {
        const res = addIngredientsToList(current, requested);
        updated = res.updated;
        if (res.added.length) summary.push(`➕ ${t(session, 'addedMsg')}: ${res.added.join(', ')}`);
        if (res.skipped.length) summary.push(`ℹ️ ${t(session, 'alreadyInListMsg')}: ${res.skipped.join(', ')}`);
      } else {
        const res = removeIngredientsFromList(current, requested);
        updated = res.updated;
        if (res.removed.length) summary.push(`➖ ${t(session, 'removedMsg')}: ${res.removed.join(', ')}`);
        if (res.notFound.length) summary.push(`⚠️ ${t(session, 'notFoundMsg')}: ${res.notFound.join(', ')}`);
      }

      if (summary.length === 0) summary.push(t(session, 'noChange'));
      pendingPantryItems.set(batchId, updated);

      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [
          { type: 'text', text: summary.join('\n') },
          buildPantryVerificationCard(updated, batchId, session),
        ],
      });
    }

    if (lower === 'burmese' || lower === 'မြန်မာ') {
      session.lang = 'my';
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ မြန်မာဘာသာသို့ ပြောင်းလဲပြီးပါပြီ!' }] });
    }
    if (lower === 'thai' || lower === 'ไทย' || lower === 'ภาษาไทย') {
      session.lang = 'th';
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ เปลี่ยนเป็นภาษาไทยเรียบร้อย!' }] });
    }
    if (lower === 'english' || lower === 'en') {
      session.lang = 'en';
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ Language set to English!' }] });
    }

    if (lower === 'help' || lower === 'menu' || lower === 'hi' || lower === 'hello' || lower === 'สวัสดี' || lower === 'မင်္ဂလာပါ') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
    }

    if (lower === 'deal' || lower === 'coupon' || lower === 'flash') {
      db.analytics.couponClaims = (db.analytics.couponClaims || 0) + 1;
      saveDB();
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildFlashDealCard()] });
    }

    if (lower.startsWith('redeem ')) {
      const code = rawText.slice(7).trim().toUpperCase();
      const partnerInfo = B2B_PARTNER_CODES[code];
      if (!partnerInfo) {
        return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❌ Invalid partner code.' }] });
      }
      if (!session.gymPartner) db.analytics.gymActivations = (db.analytics.gymActivations || 0) + 1;
      session.gymPartner = partnerInfo.partner;
      session.goals = { calories: partnerInfo.calories, protein: partnerInfo.protein, label: `${partnerInfo.partner} Plan` };
      saveDB();
      return messagingClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `✅ Linked to ${partnerInfo.partner}!` }, buildStatsCard(session)],
      });
    }

    if (lower === 'revenue' || lower === 'ads' || lower === 'business') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildB2BRevenueCard(session)] });
    }

    if (lower === 'stats' || lower === 'macros') {
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildStatsCard(session)] });
    }

    if (lower === 'saved' || lower === 'cookbook' || lower === 'favorites') {
      if (session.saved.length === 0) return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '📖 Your Cookbook is empty!' }] });
      const savedCarousel = buildRecipeCarousel(session.saved, session, false);
      return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [savedCarousel] });
    }

    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    session.lastPromptType = 'text';
    session.lastText = rawText;
    session.lastImageBase64 = null;
    recordPantryTrends(rawText, []);

    const carousel = await generateRecipesForSession(session);
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [carousel] });
  }

  if (event.message.type === 'image') {
    // A new photo cancels any half-finished ingredient edit
    session.pantryEditMode = null;
    session.pantryBatchId = null;

    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    const base64Image = await getMessageBase64(event.message.id);

    const scanLangHint = session.lang === 'my'
      ? 'Write the item names strictly in natural Burmese (မြန်မာဘာသာသီးသန့်) without English in parentheses, and never use the word "အမယ်".'
      : session.lang === 'th'
      ? 'Write the item names strictly in natural Thai (ภาษาไทยล้วน) without English in parentheses.'
      : 'Write the item names strictly in plain English.';

    const classifyRes = await generateWithFallback(
      [
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        `Analyze this image carefully. Is it a shopping/grocery RECEIPT, or a photo of FOOD/FRIDGE ingredients? List every visible food ingredient accurately. ${scanLangHint} Return ONLY valid JSON: { "type": "receipt" or "food", "receiptFoodItems": ["item 1", "item 2"], "fridgeIngredients": ["chicken breast", "garlic", "tomato"] }`,
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

    const detectedIngredients = Array.isArray(parsedClass.fridgeIngredients) && parsedClass.fridgeIngredients.length > 0
      ? parsedClass.fridgeIngredients
      : ['chicken breast', 'garlic', 'eggs', 'rice'];

    const batchId = `${Date.now()}`;
    pendingPantryItems.set(batchId, [...detectedIngredients]);
    session.lastImageBase64 = base64Image;
    session.lastPromptType = 'image';
    saveDB();

    return messagingClient.replyMessage({
      replyToken: event.replyToken,
      messages: [buildPantryVerificationCard(detectedIngredients, batchId, session)],
    });
  }

  if (event.message.type === 'audio') {
    if (event.source?.userId) messagingClient.showLoadingAnimation({ chatId: event.source.userId, loadingSeconds: 10 }).catch(() => {});
    const base64Audio = await getMessageBase64(event.message.id);

    const transcribeRes = await generateWithFallback([
      { inlineData: { mimeType: 'audio/m4a', data: base64Audio } },
      'Extract ONLY the food ingredients spoken in this voice note as a concise comma-separated phrase, keeping the exact language spoken (Burmese, Thai, or English).',
    ]);

    const spokenIngredients = transcribeRes.text.trim();
    session.lastPromptType = 'text';
    session.lastText = spokenIngredients;
    session.lastImageBase64 = null;
    recordPantryTrends(spokenIngredients, []);

    const carousel = await generateRecipesForSession(session);
    return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: `🎙️ Heard: "${spokenIngredients}"` }, carousel] });
  }

  return messagingClient.replyMessage({ replyToken: event.replyToken, messages: [buildWelcomeCard()] });
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`🚀 FridgeFriend Pro running on port ${PORT}`);
  await setupRichMenu();
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, saving db.json and closing server...');
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch {}
  server.close(() => process.exit(0));
});