require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ─── OAuth Setup ───────────────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.join(__dirname, 'oauth_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly'
];

function getOAuthClient() {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  return new OAuth2Client(client_id, client_secret, redirect_uris[0]);
}

async function getAuthorizedClient() {
  const client = getOAuthClient();
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    client.setCredentials(token);
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await client.refreshAccessToken();
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
      client.setCredentials(credentials);
    }
    return client;
  }
  throw new Error('NOT_AUTHORIZED');
}

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const client = getOAuthClient();
  const { code } = req.query;
  const { tokens } = await client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  res.send(`
    <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F8F6F1;">
    <div style="text-align:center">
      <div style="font-size:48px">✓</div>
      <h2 style="color:#098532">Authorized successfully!</h2>
      <p>You can close this tab and go back to the app.</p>
      <a href="/" style="color:#098532">← Back to Deck Generator</a>
    </div></body></html>
  `);
});

app.get('/auth-status', (req, res) => {
  res.json({ authorized: fs.existsSync(TOKEN_PATH) });
});

// ─── Fetch Website Screenshot via Microlink (desktop only) ──────────────────────
async function fetchScreenshots(url) {
  if (!url) return { desktop: null };
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const res = await axios.get('https://api.microlink.io', {
      params: { url, screenshot: true, meta: false },
      timeout: 20000
    });
    const desktop = res.data?.data?.screenshot?.url || null;
    console.log('Desktop screenshot:', desktop || 'failed');
    return { desktop };
  } catch (e) {
    console.log('Screenshot fetch failed:', e.message);
    return { desktop: null };
  }
}

// ─── Fetch Logo via OpenBrand ───────────────────────────────────────────────────
async function fetchLogo(url) {
  try {
    if (!url) return null;
    if (!url.startsWith('http')) url = 'https://' + url;
    const res = await axios.get(`https://openbrand.sh/api/extract?url=${encodeURIComponent(url)}`, {
      timeout: 10000,
      headers: { 'Authorization': `Bearer ${process.env.OPENBRAND_API_KEY}` }
    });
    const logos = res.data?.data?.logos;
    if (!logos || logos.length === 0) return null;
    // Bias toward entries explicitly named as logos (URL or type contains "logo"),
    // then fall back to highest resolution. This avoids picking favicons over real logos.
    const hasLogoKeyword = entry => {
      const url  = (entry.url  || '').toLowerCase();
      const type = (entry.type || '').toLowerCase();
      return url.includes('logo') || type.includes('logo');
    };
    const sorted = [...logos].sort((a, b) => {
      const aLogo = hasLogoKeyword(a) ? 1 : 0;
      const bLogo = hasLogoKeyword(b) ? 1 : 0;
      if (bLogo !== aLogo) return bLogo - aLogo; // logo-named entries first
      return (b.resolution?.width || 0) - (a.resolution?.width || 0); // then by resolution
    });
    const best = sorted[0];
    const w = best?.resolution?.width || 0;
    // Reject if resolution is too low — caller will fall back to site logo
    if (w < 80) { console.log('Prospect logo too small (' + w + 'px), using site fallback'); return null; }
    console.log('Prospect logo:', best?.url, `(${w}px)`);
    return best?.url || null;
  } catch (e) {
    console.log('OpenBrand logo fetch failed:', e.message);
    return null;
  }
}

// ─── Scrape Restaurant Website ─────────────────────────────────────────────────
// Tool definitions for tech stack detection
const TECH_TOOLS = {
  'WordPress':   { domain: 'wordpress.com',  pattern: /wp-content|wp-includes|wp-json/i },
  'Squarespace': { domain: 'squarespace.com', pattern: /squarespace\.com|static\.sqsp/i },
  'Wix':         { domain: 'wix.com',         pattern: /wix\.com|wixstatic\.com/i },
  'Webflow':     { domain: 'webflow.com',      pattern: /webflow\.com|webflow\.io/i },
  'BentoBox':    { domain: 'getbento.com',     pattern: /bentobox\.com|getbento\.com/i },
  'Toast':       { domain: 'toasttab.com',     pattern: /toasttab\.com/i },
  'SpotOn':      { domain: 'spoton.com',       pattern: /spoton\.com/i },
  'Square':      { domain: 'squareup.com',     pattern: /squareup\.com|square\.site/i },
  'ChowNow':     { domain: 'chownow.com',      pattern: /chownow\.com/i },
  'Chowly':      { domain: 'chowly.com',       pattern: /chowly\.com/i },
  'Olo':         { domain: 'olo.com',          pattern: /olocorp\.com|olo\.com/i },
  'Popmenu':     { domain: 'popmenu.com',      pattern: /popmenu\.com/i },
  'DoorDash':    { domain: 'doordash.com',     pattern: /doordash\.com|order\.online/i },
  'Uber Eats':   { domain: 'ubereats.com',     pattern: /ubereats\.com|order\.store/i },
  'Grubhub':     { domain: 'grubhub.com',      pattern: /grubhub\.com/i },
  'OpenTable':   { domain: 'opentable.com',    pattern: /opentable\.com/i },
  'Resy':        { domain: 'resy.com',          pattern: /resy\.com/i },
  'Tock':        { domain: 'exploretock.com',  pattern: /exploretock\.com/i },
  'SevenRooms':  { domain: 'sevenrooms.com',   pattern: /sevenrooms\.com/i },
  'Mailchimp':   { domain: 'mailchimp.com',    pattern: /mailchimp\.com|list-manage\.com/i },
  'Klaviyo':     { domain: 'klaviyo.com',       pattern: /klaviyo\.com/i },
  'Zenreach':    { domain: 'zenreach.com',      pattern: /zenreach\.com/i },
  'Slice':       { domain: 'slicelife.com',     pattern: /slicelife\.com/i },
  'SpotHopper':  { domain: 'spothopperapp.com', pattern: /spothopperapp\.com|spothopper\.com/i },
};

async function scrapeWebsite(url) {
  try {
    if (!url.startsWith('http')) url = 'https://' + url;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeckBot/1.0)' }
    });
    const $ = cheerio.load(res.data);

    // Collect raw signals before stripping scripts
    const scripts = [], links = [];
    $('script[src]').each((_, el) => scripts.push($(el).attr('src') || ''));
    $('a[href]').each((_, el) => links.push($(el).attr('href') || ''));
    const allText = scripts.join(' ') + ' ' + links.join(' ') + ' ' + res.data.slice(0, 100000);

    // Detect tech stack — check page content AND the URL itself (e.g. slicelife.com-hosted pages)
    const techStack = Object.entries(TECH_TOOLS)
      .filter(([, { pattern }]) => pattern.test(allText) || pattern.test(url))
      .map(([name, { domain }]) => ({ name, domain }));
    console.log('Tech stack:', techStack.map(t => t.name).join(', ') || 'none');

    // Try to extract a high-quality logo from the page itself (apple-touch-icon is 180×180)
    let siteLogoUrl = null;
    const iconHref = $('link[rel="apple-touch-icon"]').first().attr('href') ||
                     $('link[rel="apple-touch-icon-precomposed"]').first().attr('href');
    if (iconHref) {
      siteLogoUrl = iconHref.startsWith('http') ? iconHref : new URL(iconHref, url).href;
    }

    $('script, style, nav, footer, header').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
    const title = $('title').text().trim();
    const description = $('meta[name="description"]').attr('content') || '';
    return { text, title, description, success: true, techStack, siteLogoUrl };
  } catch (e) {
    return { text: '', title: '', description: '', success: false, techStack: [], siteLogoUrl: null };
  }
}

// ─── Title Case Helper ──────────────────────────────────────────────────────────
function toTitleCase(str) {
  if (!str) return str;
  const minor = new Set(['a','an','the','and','but','or','for','nor','on','at','to','by','of','in','up']);
  return str.toLowerCase().split(' ').map((word, i) => {
    if (!word) return word;
    // Always capitalise first word; skip minor words elsewhere
    if (i === 0 || !minor.has(word)) return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  }).join(' ');
}

// ─── Generate Deck Content via Claude ──────────────────────────────────────────
async function generateDeckContent(formData, websiteData) {
  // Sanitize free-text fields before embedding in the prompt — stray quotes/backticks
  // can cause the AI to produce malformed JSON that fails to parse.
  const sanitize = str => (str || '').replace(/[`"\\]/g, ' ').trim();
  const safeNotes       = sanitize(formData.dealNotes);
  const safeTitle       = sanitize(websiteData.title);
  const safeDescription = sanitize(websiteData.description);
  const safeText        = sanitize(websiteData.text.slice(0, 1500));

  const prompt = `You are writing content for a sales deck for Owner.com — a restaurant technology platform.

ABOUT OWNER:
Owner is the #1 rated restaurant software (4.8/5, 970+ reviews, #1 on G2). Over 7,500 restaurant locations on the platform. Over $1 billion in GPV driven for customers. $240M+ raised. Engineering team from Shopify, Meta, DoorDash. Six products: Website with AI SEO, Google & local listings, Online Ordering, Branded Mobile App, Loyalty & Rewards, Email & SMS Automations.

THE PROSPECT:
- Restaurant name: ${formData.restaurantName}
- Website: ${formData.websiteUrl}
- Rep name: ${formData.repName}
- Deal notes from rep: ${safeNotes}
- Monthly 3PD volume: ${formData.thirdPartyVolume || 'not provided'}
- 3PD commission rate: ${formData.thirdPartyCommission || 'not provided'}%

WEBSITE DATA SCRAPED:
Title: ${safeTitle}
Description: ${safeDescription}
Content preview: ${safeText}

YOUR JOB:
Write content for a sales deck. This is a slide deck, not a document. Every word must earn its place.

Rules:
- Headlines: punchy, specific, under 10 words.
- Body paragraphs (blurbP1, blurbP2): 2 short sentences each. HARD LIMIT: 25 words per paragraph, 50 words total across both paragraphs combined. Count every word — if you exceed 25 words in a paragraph, cut it down before returning. Write at a 7th-grade reading level. Short sentences. Plain words.
- No filler phrases ("In today's world", "It's no secret", "Simply put").
- Be specific to this prospect — use their numbers, their words, their situation.
- If the deal notes mention a competitor or a platform they are switching away from (e.g. "moving off Toast", "leaving DoorDash"), name that competitor explicitly in the online_experience and sales_growth slides where relevant.
- Write like a sharp advisor, not a copywriter.
- COMMISSION/FEES LANGUAGE: talk about fees, commissions, and "Owner doesn't charge unfair fees" ONLY on the third_party slide. Do NOT mention commission rates, "no commission", "no platform tax", or anything about Owner's pricing on any other slide.
- Do NOT mention any specific percentage for how much 3PD volume can be converted to direct orders.
- Do NOT mention phone numbers anywhere. Ordering should always be framed as easy, digital, and frictionless — never "call to order".
- techStackFromNotes: scan the deal notes for any platforms, POS systems, delivery apps, ordering tools, or tech vendors mentioned (e.g. "Toast", "SpotOn", "DoorDash", "Uber Eats", "Fox ordering", "Chowly", "Square"). For each one found, return { "name": "...", "domain": "..." } where domain is the correct domain for fetching a favicon. Known correct domains: Toast → "toasttab.com", DoorDash → "doordash.com", Uber Eats → "ubereats.com", SpotHopper → "spothopperapp.com", Square → "squareup.com", Grubhub → "grubhub.com". Return an empty array if none are mentioned. Do NOT duplicate companies already obviously in the website tech stack — the server will deduplicate, but no need to add noise.

Return ONLY valid JSON — no markdown, no backticks, no explanation, no text before or after the JSON object. The JSON must contain exactly the slides defined below — do NOT add extra slides (no "financials", "implementation", "pricing", "next_steps", or anything else). Just raw JSON:

{
  "deckTitle": "Owner x [Restaurant Name]",
  "techStackFromNotes": [{ "name": "[platform name]", "domain": "[best-guess favicon domain]" }],
  "slides": [
    {
      "id": "about_owner",
      "sectionLabel": "ABOUT OWNER",
      "headline": "The #1 rated restaurant growth platform.",
      "bullets": [
        "#1 rated restaurant software — 4.8/5 across 970+ reviews, #1 on G2",
        "7,500+ restaurant locations on our platform",
        "$1B+ in GPV driven for our customers",
        "$240M+ raised — investors include OpenAI, Sweetgreen, CAVA leadership",
        "Engineering team from Shopify, Meta, and DoorDash"
      ]
    },
    {
      "id": "market_forces",
      "sectionLabel": "MARKET FORCES",
      "headline": "The internet changed how guests decide where to eat. Most restaurants haven't kept up.",
      "stats": [
        { "label": "The decision happens at home.", "stat": "77%", "sub": "of purchase decisions start online before a guest ever leaves" },
        { "label": "Google is the front door.", "stat": "66%", "sub": "of new restaurant discoveries start with a search" },
        { "label": "One bad experience, one lost order.", "stat": "75%", "sub": "won't order from a place with a poor online presence" }
      ]
    },
    {
      "id": "diagnosis",
      "order": ["[primary branch — the most prominent pain from deal notes]", "[secondary branch]", "[tertiary branch]"],
      "note": "order must be an array of exactly 3 strings chosen from: 'online_experience', 'sales_growth', 'third_party'. Rank them by how strongly the deal notes signal each pain.",
      "online_experience": {
        "sectionLabel": "YOUR ONLINE PRESENCE",
        "headline": "[6-8 word headline about the fragmented tech stack creating a disconnected, frustrating guest experience that costs orders]",
        "blurbP1": "Today, [2 sentences about the fragmented tech stack this restaurant is running — multiple disconnected tools (name them if identifiable from the tech stack or deal notes, e.g. a 3PD ordering link, an old website builder) that create a disjointed guest journey. If a competitor or platform they're moving away from is mentioned in deal notes, reference it here.]",
        "blurbP2": "[2 sentences about the outcome: when the online experience feels patched together, guests drop off. A streamlined, end-to-end online experience — from discovery to checkout — turns more visitors into paying customers.]"
      },
      "sales_growth": {
        "sectionLabel": "YOUR GROWTH CEILING",
        "headline": "[6-8 word definitive statement — NOT a search-query fragment. MUST include the word 'SEO' or 'search'. Frame it as a fact about growth or discoverability this restaurant is missing out on. Example style: 'Better SEO means more guests find you first.' — a complete, confident claim.]",
        "blurbP1": "Today, [2 sentences, MAX 25 WORDS TOTAL — about how new guests can't easily find this restaurant through organic search. The current site is not winning that traffic. If a competitor they're switching from is mentioned, you may reference it briefly.]",
        "blurbP2": "[2 sentences, MAX 25 WORDS TOTAL — about the opportunity: ranking higher in search means more new customers discovering this restaurant. Focus on growing their customer base and discoverability. Do NOT mention 'free traffic', 'renting traffic', third-party platforms, or any external party.]"
      },
      "third_party": {
        "sectionLabel": "YOUR 3PD DEPENDENCY",
        "headline": "[6-8 word headline — PURELY emotional. Themes: owning your destiny, not depending on platforms, taking back control. HARD RULE — NEVER BREAK THIS: no numbers, no dollar signs, no percentages, no math of any kind in the headline. BAD example: 'Every $100 in orders isn't $100 to you.' — that has a dollar amount, never do this. GOOD example: 'Stop letting platforms own your customers.' — pure emotion, zero math. Write a GOOD headline.]",
        "blurbP1": "Today, [2 sentences about the commission drain. Specific to this restaurant — use their volume/commission numbers if provided. Name the monthly and/or annual dollar cost.]",
        "blurbP2": "[2 sentences about Owner's model. Unlike 3PD platforms, Owner doesn't charge unfair fees — more of every order stays with the restaurant. Growing with Owner means growing real profit, not just top-line revenue.]"
      }
    },
    {
      "id": "solution",
      "note": "Each solution slide gets a tagline (personalized 1-liner under the section title) and a custom 3rd bullet. Both must tie directly to this restaurant's situation, tech stack, deal notes, or goals. Sharp and specific — no generic filler.",
      "visibility": {
        "tagline": "[1 sentence, max 12 words — personalized to this restaurant. Connect to their current tech stack, location, or traffic situation.]",
        "bullet3": "[1 sentence, max 15 words — specific to this restaurant. How Owner's SEO-powered website would drive more organic traffic for them given their current situation.]"
      },
      "conversion": {
        "tagline": "[1 sentence, max 12 words — personalized. Connect to how guests currently have to navigate a clunky or fragmented ordering experience to order from this restaurant.]",
        "bullet3": "[1 sentence, max 15 words — specific to this restaurant. How Owner's streamlined digital ordering experience turns more website visitors into paying customers. NEVER mention phone numbers.]"
      },
      "repeat_orders": {
        "tagline": "[1 sentence, max 12 words — personalized. Connect to their customer base, repeat visit patterns, or loyalty gap.]",
        "bullet3": "[1 sentence, max 15 words — specific to this restaurant. How Owner's mobile app or loyalty features would drive repeat visits from their customer base.]"
      }
    }
  ]
}`;

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });

  let text = response.data.content[0].text;

  // Strip markdown fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // Extract just the outermost JSON object by counting braces.
  // lastIndexOf('}') is unreliable when the AI adds trailing commentary containing braces.
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    let depth = 0, jsonEnd = -1, inString = false, escape = false;
    for (let i = jsonStart; i < text.length; i++) {
      const ch = text[i];
      if (escape)          { escape = false; continue; }
      if (ch === '\\')     { escape = true;  continue; }
      if (ch === '"')      { inString = !inString; continue; }
      if (inString)        continue;
      if (ch === '{')      depth++;
      else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
    }
    if (jsonEnd !== -1) text = text.slice(jsonStart, jsonEnd + 1);
  }

  // Fix trailing commas (common AI mistake)
  text = text.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('JSON parse failed:', e.message);
    console.error('Raw AI response:\n', text);
    throw new Error(`AI returned invalid JSON (${e.message}). Check server terminal for full response.`);
  }
}

// ─── Build Google Slides ────────────────────────────────────────────────────────
async function buildGoogleSlides(deckContent, formData, auth, screenshots = {}, prospectLogoUrl = null, techStack = []) {
  const slidesApi = google.slides({ version: 'v1', auth });
  const driveApi = google.drive({ version: 'v3', auth });

  const GREEN  = { red: 0.035, green: 0.522, blue: 0.196 };
  const CREAM  = { red: 0.973, green: 0.965, blue: 0.945 };
  const DARK   = { red: 0.114, green: 0.114, blue: 0.114 };
  const GRAY   = { red: 0.4,   green: 0.4,   blue: 0.4   };
  const WHITE  = { red: 1,     green: 1,      blue: 1     };
  const CARD   = { red: 0.933, green: 0.918,  blue: 0.890 };

  const pt = n => n * 12700;
  const SW = 9144000, SH = 5143500;

  // Create file in Drive
  const file = await driveApi.files.create({
    requestBody: {
      name: deckContent.deckTitle,
      mimeType: 'application/vnd.google-apps.presentation',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    },
    fields: 'id'
  });
  const presId = file.data.id;

  // Get existing slide and delete its default placeholders
  const presData = await slidesApi.presentations.get({ presentationId: presId });
  const existingSlideId = presData.data.slides[0].objectId;
  const slideIds = [existingSlideId];

  const placeholderIds = (presData.data.slides[0].pageElements || [])
    .filter(el => el.shape && el.shape.placeholder)
    .map(el => el.objectId);
  if (placeholderIds.length > 0) {
    await slidesApi.presentations.batchUpdate({
      presentationId: presId,
      requestBody: { requests: placeholderIds.map(id => ({ deleteObject: { objectId: id } })) }
    });
  }

  // Create 12 more slides (13 total: cover + about + market + 2 section titles + 3 diagnosis + tap + visibility + conversion + repeat orders + social proof)
  const createReqs = [];
  for (let i = 1; i < 13; i++) {
    const sid = `slide_${i}_${Math.random().toString(36).slice(2, 8)}`;
    slideIds.push(sid);
    createReqs.push({
      createSlide: {
        objectId: sid,
        insertionIndex: i,
        slideLayoutReference: { predefinedLayout: 'BLANK' }
      }
    });
  }
  await slidesApi.presentations.batchUpdate({
    presentationId: presId,
    requestBody: { requests: createReqs }
  });

  const all = [];

  // Helpers
  const bg    = (sid, color) => [{ updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: color } } } }, fields: 'pageBackgroundFill' } }];
  const bgImg = (sid, url)   => [{ updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: url } } }, fields: 'pageBackgroundFill' } }];

  const rect = (sid, x, y, w, h, color, shapeType = 'RECTANGLE') => {
    const id = `r_${Math.random().toString(36).slice(2,9)}`;
    return { id, reqs: [
      { createShape: { objectId: id, shapeType, elementProperties: { pageObjectId: sid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
      { updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: color } } }, outline: { outlineFill: { solidFill: { color: { rgbColor: color } } } } }, fields: 'shapeBackgroundFill,outline' } }
    ]};
  };

  const tb = (sid, text, x, y, w, h, opts = {}) => {
    const id = `t_${Math.random().toString(36).slice(2,9)}`;
    const reqs = [
      { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: sid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
      { insertText: { objectId: id, text: String(text), insertionIndex: 0 } }
    ];
    const styleFields = [];
    const style = {};
    if (opts.fontSize) { style.fontSize = { magnitude: opts.fontSize, unit: 'PT' }; styleFields.push('fontSize'); }
    if (opts.color)    { style.foregroundColor = { opaqueColor: { rgbColor: opts.color } }; styleFields.push('foregroundColor'); }
    if (opts.bold)     { style.bold = true; styleFields.push('bold'); }
    if (opts.font)     { style.fontFamily = opts.font; styleFields.push('fontFamily'); }
    if (styleFields.length) reqs.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style, fields: styleFields.join(',') } });
    if (opts.align)    reqs.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: opts.align }, fields: 'alignment' } });
    return { id, reqs };
  };

  // Native bullet list — lines joined by \n, createParagraphBullets applied
  const bulletList = (sid, lines, x, y, w, h, opts = {}) => {
    const id = `t_${Math.random().toString(36).slice(2,9)}`;
    const reqs = [
      { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: sid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
      { insertText: { objectId: id, text: lines.join('\n'), insertionIndex: 0 } }
    ];
    const styleFields = [];
    const style = {};
    if (opts.fontSize) { style.fontSize = { magnitude: opts.fontSize, unit: 'PT' }; styleFields.push('fontSize'); }
    if (opts.color)    { style.foregroundColor = { opaqueColor: { rgbColor: opts.color } }; styleFields.push('foregroundColor'); }
    if (opts.font)     { style.fontFamily = opts.font; styleFields.push('fontFamily'); }
    if (styleFields.length) reqs.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style, fields: styleFields.join(',') } });
    // Add some breathing room between bullet items
    reqs.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { spaceAbove: { magnitude: 10, unit: 'PT' }, lineSpacing: 120 }, fields: 'spaceAbove,lineSpacing' } });
    // Apply native Google Slides bullet formatting
    reqs.push({ createParagraphBullets: { objectId: id, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    return { id, reqs };
  };

  const logo = sid => tb(sid, 'Owner', SW - pt(80), pt(14), pt(70), pt(22), { fontSize: 13, color: DARK, bold: true, align: 'END' }).reqs;
  const label = (sid, text, x, y) => tb(sid, text, x, y, pt(300), pt(18), { fontSize: 9, color: GREEN, bold: true }).reqs;

  // Insert an image by URL
  const img = (sid, url, x, y, w, h) => ({
    createImage: {
      objectId: `img_${Math.random().toString(36).slice(2, 9)}`,
      url,
      elementProperties: {
        pageObjectId: sid,
        size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' }
      }
    }
  });

  // Text box with mixed bold/normal runs: segments = [{ text, bold }]
  const tbMixed = (sid, segments, x, y, w, h, baseOpts = {}) => {
    const fullText = segments.map(s => s.text).join('');
    const id = `t_${Math.random().toString(36).slice(2, 9)}`;
    const reqs = [
      { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: sid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
      { insertText: { objectId: id, text: fullText, insertionIndex: 0 } }
    ];
    const baseStyle = { bold: false };
    const baseFields = ['bold'];
    if (baseOpts.fontSize) { baseStyle.fontSize = { magnitude: baseOpts.fontSize, unit: 'PT' }; baseFields.push('fontSize'); }
    if (baseOpts.color)    { baseStyle.foregroundColor = { opaqueColor: { rgbColor: baseOpts.color } }; baseFields.push('foregroundColor'); }
    if (baseOpts.font)     { baseStyle.fontFamily = baseOpts.font; baseFields.push('fontFamily'); }
    reqs.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style: baseStyle, fields: baseFields.join(',') } });
    let idx = 0;
    for (const seg of segments) {
      if (seg.bold) {
        reqs.push({ updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: idx, endIndex: idx + seg.text.length }, style: { bold: true }, fields: 'bold' } });
      }
      idx += seg.text.length;
    }
    if (baseOpts.align) reqs.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: baseOpts.align }, fields: 'alignment' } });
    return { id, reqs };
  };

  // Static asset URLs
  const ASSETS = {
    ownerLogo:          'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/owner-logo-black.png',
    titleBg:            'https://raw.githubusercontent.com/davelocity/deckgen/refs/heads/main/background-title-slide.png',
    sectionTitleBg:     'https://github.com/davelocity/deckgen/blob/main/background-section-title-slide.png?raw=true',
    contentBg:          'https://raw.githubusercontent.com/davelocity/deckgen/refs/heads/main/background-content-slide.png',
    investorOpenAI:     'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/investor-openai.png',
    investorSweetgreen: 'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/investor-sweetgreen.png',
    investorCava:       'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/investor-cava.png',
    g2Leader:           'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/g2-award-leader.jpg',
    g2Results:          'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/g2-award-results.png',
    g2Usability:        'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/g2-award-usability.png',
    logoBlock:          'https://raw.githubusercontent.com/davelocity/deckgen/2d4ba2483fd47b9366f68402c173af935da5f636/logo-block.png',
  };

  const d = deckContent.slides;

  // ── SLIDE 0: Cover ────────────────────────────────────────────────────────────
  const s0 = slideIds[0];
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  all.push(...bgImg(s0, ASSETS.titleBg));

  // Main title — restaurant name + "&\nOwner.com"
  // Height capped at pt(145) so it never overlaps the meta block below
  // Dynamic font size: shrink for long restaurant names so the title never overflows
  const coverFontSize = formData.restaurantName.length > 28 ? 40 : 52;
  all.push(...tb(s0, `${formData.restaurantName} &\nOwner.com`, pt(44), pt(82), SW * 0.82, pt(145),
    { fontSize: coverFontSize, color: DARK, bold: true, font: 'Inter Tight' }).reqs);

  // Meta block — single text box so it can never overlap the title
  // Starts at pt(265), safely below the title's maximum bottom edge of pt(227)
  const metaText = `Partnership Proposal\nPrepared by ${formData.repName}\n${today}`;
  all.push(...tb(s0, metaText, pt(44), pt(265), pt(420), pt(80),
    { fontSize: 13, color: DARK, font: 'Inter Tight' }).reqs);

  // ── SLIDE 1: About Owner ──────────────────────────────────────────────────────
  // Static slide — full PNG background, no editable elements needed.
  // To update: export the canonical "Who is Owner" slide as PDF → PNG and replace the GitHub asset.
  const s1 = slideIds[1];
  all.push({
    updatePageProperties: {
      objectId: s1,
      pageProperties: {
        pageBackgroundFill: {
          stretchedPictureFill: {
            contentUrl: 'https://raw.githubusercontent.com/davelocity/deckgen/main/slide-about-owner.png'
          }
        }
      },
      fields: 'pageBackgroundFill'
    }
  });

  // ── SLIDE 2: Market Forces ────────────────────────────────────────────────────
  // Static slide — full PNG background, no editable elements needed.
  // To update: export the canonical "Market Shifts" slide as PDF → PNG and replace the GitHub asset.
  const s2 = slideIds[2];
  all.push({
    updatePageProperties: {
      objectId: s2,
      pageProperties: {
        pageBackgroundFill: {
          stretchedPictureFill: {
            contentUrl: 'https://raw.githubusercontent.com/davelocity/deckgen/main/slide-market-shifts.png'
          }
        }
      },
      fields: 'pageBackgroundFill'
    }
  });

  // ── SLIDE 3: Section Title — Current State ────────────────────────────────────
  const sTitle = slideIds[3];
  all.push(...bgImg(sTitle, ASSETS.sectionTitleBg));

  // Prospect logo — large square, top-left
  if (prospectLogoUrl) {
    all.push(img(sTitle, prospectLogoUrl, pt(44), pt(36), pt(74), pt(74)));
  }

  // Two-line header: restaurant name (dark) / subtitle (gray) — same size, same bold weight
  all.push(...tb(sTitle, formData.restaurantName + ':', pt(44), pt(130), SW * 0.70, pt(56),
    { fontSize: 40, color: DARK, bold: true, font: 'Inter Tight' }).reqs);
  all.push(...tb(sTitle, 'State of Online Presence', pt(44), pt(182), SW * 0.70, pt(56),
    { fontSize: 40, color: GRAY, bold: true, font: 'Inter Tight' }).reqs);

  // ── SLIDES 4–6: Diagnosis / Current State (3 slides, order determined by AI) ──
  const { desktop } = screenshots;
  const diag = d.find(s => s.id === 'diagnosis');
  const diagOrder = (diag && Array.isArray(diag.order)) ? diag.order : ['online_experience', 'sales_growth', 'third_party'];

  // 3PD calculator numbers
  const rawVol  = parseFloat((formData.thirdPartyVolume   || '').replace(/[^0-9.]/g, '')) || 0;
  const rawComm = parseFloat((formData.thirdPartyCommission || '').replace(/[^0-9.]/g, '')) || 0;
  const hasVol  = rawVol > 0;
  const hasComm = rawComm > 0;
  const monthlyCommCost = rawVol * (rawComm / 100);
  const annualCommCost  = monthlyCommCost * 12;
  const fmt = n => n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : (n > 0 ? '$' + n.toFixed(0) : 'TBC');

  // Shared layout constants for all 3 diagnosis slides
  // Text is always LEFT, visual is always RIGHT
  // ~8% gutter between the two columns
  const txtX = pt(44);
  const txtW = SW * 0.42;
  const visX = SW * 0.57;
  const visW = SW * 0.40;

  diagOrder.forEach((diagType, position) => {
    const sid = slideIds[4 + position];
    const data     = diag ? diag[diagType] : {};
    const secLabel = (data && data.sectionLabel) || diagType.replace(/_/g, ' ').toUpperCase();
    const headline = (data && data.headline)  || '';
    const blurbP1  = (data && data.blurbP1)   || '';
    const blurbP2  = (data && data.blurbP2)   || '';

    // ── Shared: background, headline, combined blurb ────────────────────────────
    all.push(...bgImg(sid, ASSETS.contentBg));
    all.push(...tb(sid, headline, txtX, pt(44), txtW, pt(78),
      { fontSize: 22, color: DARK, bold: true, font: 'Inter Tight' }).reqs);
    // Both paragraphs in one text box — single \n creates a paragraph break
    // that flows tightly without the big gap that came from two separate boxes
    all.push(...tb(sid, blurbP1 + '\n\n' + blurbP2, txtX, pt(138), txtW, pt(230),
      { fontSize: 16, color: GRAY, font: 'Inter Tight' }).reqs);

    if (diagType === 'online_experience') {
      // ── Diagnosis A: Website / Online Experience ─────────────────────────────
      // RIGHT: rounded-rect screenshot (white border) + dynamic favicon box below

      // Favicon box sizing (calculated first so we can derive screenshot height)
      const icons    = techStack.slice(0, 8);
      const iconSize = pt(26);
      const iconGap  = pt(10);
      const favPadX  = pt(18);
      const favPadY  = pt(10);
      const totalIconW = icons.length > 0
        ? icons.length * iconSize + (icons.length - 1) * iconGap
        : iconSize;
      const favBoxW = Math.min(totalIconW + favPadX * 2, visW - pt(16));
      const favBoxH = iconSize + favPadY * 2;
      const eyebrowH = pt(14);
      const eyebrowGap = pt(5);
      const botMargin = pt(14);
      const favBoxY = SH - botMargin - favBoxH;
      const eyebrowY = favBoxY - eyebrowGap - eyebrowH;

      // Screenshot: rounded rectangle with picture fill + 2pt white border
      const shotX = visX + pt(6);
      const shotY = pt(6);
      const shotW = visW - pt(12);
      const shotH = eyebrowY - pt(10) - shotY; // gap between shot bottom and eyebrow

      const favBoxX = visX + (visW - favBoxW) / 2; // centered under screenshot

      if (desktop) {
        // createImage + updateImageProperties outline — cleanest approach, no extra elements
        const shotImgId = `img_${Math.random().toString(36).slice(2, 9)}`;
        all.push({
          createImage: {
            objectId: shotImgId, url: desktop,
            elementProperties: {
              pageObjectId: sid,
              size: { width: { magnitude: shotW, unit: 'EMU' }, height: { magnitude: shotH, unit: 'EMU' } },
              transform: { scaleX: 1, scaleY: 1, translateX: shotX, translateY: shotY, unit: 'EMU' }
            }
          }
        });
        all.push({
          updateImageProperties: {
            objectId: shotImgId,
            imageProperties: {
              outline: {
                outlineFill: { solidFill: { color: { rgbColor: WHITE } } },
                weight: { magnitude: 8, unit: 'PT' },
                dashStyle: 'SOLID'
              }
            },
            fields: 'outline'
          }
        });
      } else {
        // No screenshot — light placeholder
        all.push(...rect(sid, shotX, shotY, shotW, shotH, CARD).reqs);
        all.push(...tb(sid, 'WEBSITE SCREENSHOT', shotX, shotY + shotH * 0.44, shotW, pt(30),
          { fontSize: 9, color: GRAY, bold: true, font: 'Inter Tight', align: 'CENTER' }).reqs);
      }

      // "Tech stack" eyebrow above the favicon box — full panel width so text never wraps
      if (icons.length > 0) {
        all.push(...tb(sid, 'Tech stack', visX, eyebrowY, visW, eyebrowH,
          { fontSize: 7, color: GRAY, bold: true, font: 'Inter Tight', align: 'CENTER' }).reqs);

        // Rounded favicon box (dynamic width) — white background so favicons render cleanly
        all.push(...rect(sid, favBoxX, favBoxY, favBoxW, favBoxH, WHITE, 'ROUND_RECTANGLE').reqs);

        // Favicons centered inside box
        const iconStartX = favBoxX + (favBoxW - totalIconW) / 2;
        icons.forEach((tool, i) => {
          const fx = iconStartX + i * (iconSize + iconGap);
          all.push(img(sid, `https://www.google.com/s2/favicons?domain=${tool.domain}&sz=64`, fx, favBoxY + favPadY, iconSize, iconSize));
        });
      }

    } else if (diagType === 'sales_growth') {
      // ── Diagnosis B: SEO / Growth Ceiling ────────────────────────────────────
      // RIGHT: grader screenshot placeholder box
      const phH = SH * 0.72;
      const phY = (SH - phH) / 2;
      // Outer + inset border to simulate a frame
      all.push(...rect(sid, visX, phY, visW, phH, { red: 0.878, green: 0.863, blue: 0.839 }).reqs);
      all.push(...rect(sid, visX + pt(3), phY + pt(3), visW - pt(6), phH - pt(6),
        { red: 0.82, green: 0.80, blue: 0.77 }).reqs);
      all.push(...rect(sid, visX + pt(6), phY + pt(6), visW - pt(12), phH - pt(12),
        { red: 0.878, green: 0.863, blue: 0.839 }).reqs);
      all.push(...tb(sid, 'PLACE GRADER SCORE\nSCREENSHOT HERE',
        visX, phY + phH * 0.42, visW, pt(40),
        { fontSize: 9, color: GRAY, bold: true, font: 'Inter Tight', align: 'CENTER' }).reqs);

    } else {
      // ── Diagnosis C: 3PD Dependency / Commission Calculator ──────────────────
      // RIGHT: 3 rounded-corner boxes (~10% smaller than before), numbers right-aligned
      const SOFT = { red: 0.38, green: 0.38, blue: 0.38 }; // softer than DARK so boxes don't compete with the headline

      const boxW   = Math.round((visW - pt(8)) * 0.90);  // 10% narrower
      const boxH   = pt(86);                              // 10% shorter (was pt(96))
      const boxGap = pt(16);
      const box1Y  = SH * 0.10;
      const box2Y  = box1Y + boxH + boxGap;
      const box3Y  = box2Y + boxH + boxGap;
      const bx     = visX + Math.round((visW - boxW) / 2); // centered in right panel
      const pad    = pt(16);

      // Box 1 — Monthly 3PD Volume
      all.push(...rect(sid, bx, box1Y, boxW, boxH, CARD, 'ROUND_RECTANGLE').reqs);
      all.push(...tb(sid, 'MONTHLY 3PD VOLUME', bx + pad, box1Y + pt(8), boxW - pad * 2, pt(14),
        { fontSize: 8, color: GRAY, bold: true, font: 'Inter Tight' }).reqs);
      all.push(...tb(sid, hasVol ? fmt(rawVol) : 'TBC', bx + pad, box1Y + pt(24), boxW - pad * 2, pt(46),
        { fontSize: 26, color: SOFT, bold: true, font: 'Inter Tight', align: 'END' }).reqs);

      // Box 2 — Commission Rate
      all.push(...rect(sid, bx, box2Y, boxW, boxH, CARD, 'ROUND_RECTANGLE').reqs);
      all.push(...tb(sid, '3PD COMMISSION RATE', bx + pad, box2Y + pt(8), boxW - pad * 2, pt(14),
        { fontSize: 8, color: GRAY, bold: true, font: 'Inter Tight' }).reqs);
      all.push(...tb(sid, hasComm ? rawComm + '%' : 'TBC', bx + pad, box2Y + pt(24), boxW - pad * 2, pt(46),
        { fontSize: 26, color: SOFT, bold: true, font: 'Inter Tight', align: 'END' }).reqs);

      // Box 3 — Monthly Cost (green bg, white text)
      all.push(...rect(sid, bx, box3Y, boxW, boxH, GREEN, 'ROUND_RECTANGLE').reqs);
      all.push(...tb(sid, 'MONTHLY COMMISSION COST', bx + pad, box3Y + pt(8), boxW - pad * 2, pt(14),
        { fontSize: 8, color: { red: 0.72, green: 0.92, blue: 0.72 }, bold: true, font: 'Inter Tight' }).reqs);
      all.push(...tb(sid, (hasVol && hasComm) ? fmt(monthlyCommCost) : 'TBC', bx + pad, box3Y + pt(24), boxW - pad * 2, pt(46),
        { fontSize: 26, color: WHITE, bold: true, font: 'Inter Tight', align: 'END' }).reqs);

      // Annual footnote
      if (annualCommCost > 0) {
        all.push(...tb(sid, `${fmt(annualCommCost)} per year in commissions.`,
          bx, box3Y + boxH + pt(10), boxW, pt(20),
          { fontSize: 9, color: GRAY, font: 'Inter Tight', align: 'END' }).reqs);
      }
    }
  });

  // Solution slide layout constants
  const solTxtX  = pt(44);
  const solTxtW  = SW * 0.40;   // slightly narrower to keep clear of the video
  const solVidX  = SW * 0.53;
  const solVidW  = SW * 0.44;
  const solVidY  = pt(20);
  const solVidH  = solVidW;          // 1:1 aspect ratio to avoid thumbnail distortion
  const solCapY  = solVidY + solVidH + pt(10);
  const solCapH  = SH - solCapY - pt(10);
  const solCapW  = solVidW * 0.72;                       // narrower than video to avoid edge crowding
  const solCapX  = solVidX + (solVidW - solCapW) / 2;   // centered under video

  // Helper: render a solution slide's left-column content
  const solutionLeft = (sid, title, tagline, b1, b2, b3) => {
    // Title
    all.push(...tb(sid, title, solTxtX, pt(38), solTxtW, pt(46),
      { fontSize: 24, color: DARK, bold: true, font: 'Inter Tight' }).reqs);
    // Personalized tagline — restaurant-specific one-liner
    all.push(...tb(sid, tagline, solTxtX, pt(90), solTxtW, pt(30),
      { fontSize: 13, color: GRAY, font: 'Inter Tight' }).reqs);
    // Intro label above bullet list
    all.push(...tb(sid, 'With Owner.com partnership:', solTxtX, pt(132), solTxtW, pt(26),
      { fontSize: 13, color: DARK, bold: true, font: 'Inter Tight' }).reqs);
    // Bullet list
    all.push(...bulletList(sid, [b1, b2, b3], solTxtX, pt(158), solTxtW, SH - pt(172),
      { fontSize: 13, color: GRAY, font: 'Inter Tight' }).reqs);
  };

  // Pull AI-generated 3rd bullets from deckContent
  const sol = d.find(s => s.id === 'solution') || {};
  const visTagline    = sol.visibility?.tagline    || '';
  const convTagline   = sol.conversion?.tagline    || '';
  const repeatTagline = sol.repeat_orders?.tagline || '';
  const visBullet3    = sol.visibility?.bullet3    || 'Your guests will find you first — before the competition.';
  const convBullet3   = sol.conversion?.bullet3    || 'A checkout experience your guests won\'t abandon.';
  const repeatBullet3 = sol.repeat_orders?.bullet3 || 'Keep your regulars coming back on their own terms.';

  // ── SLIDE 7: Section Title — Growth Opportunities ────────────────────────────
  const sGrowth = slideIds[7];
  all.push(...bgImg(sGrowth, ASSETS.sectionTitleBg));
  if (prospectLogoUrl) {
    all.push(img(sGrowth, prospectLogoUrl, pt(44), pt(36), pt(74), pt(74)));
  }
  all.push(...tb(sGrowth, formData.restaurantName + ':', pt(44), pt(130), SW * 0.70, pt(56),
    { fontSize: 40, color: DARK, bold: true, font: 'Inter Tight' }).reqs);
  all.push(...tb(sGrowth, 'Growth Opportunities', pt(44), pt(182), SW * 0.70, pt(56),
    { fontSize: 40, color: GRAY, bold: true, font: 'Inter Tight' }).reqs);

  // ── SLIDE 8: Visibility ───────────────────────────────────────────────────────
  const sVis = slideIds[8];
  all.push(...bgImg(sVis, ASSETS.contentBg));
  solutionLeft(sVis, 'Grow Visibility', visTagline,
    'Get around 20% more Google traffic in 30 days',
    'AI-powered websites that max out your SEO traffic',
    visBullet3
  );
  all.push(...tb(sVis, 'Sarkis from Township Line Pizza got to the top of Google with our world-class SEO.',
    solCapX, solCapY, solCapW, solCapH,
    { fontSize: 9, color: GRAY, font: 'Inter Tight', align: 'CENTER' }).reqs);

  // ── SLIDE 9: Conversion ──────────────────────────────────────────────────────
  const sConv = slideIds[9];
  all.push(...bgImg(sConv, ASSETS.contentBg));
  solutionLeft(sConv, 'Grow Conversion', convTagline,
    'Get up to 80% more conversions vs. avg restaurant website',
    'We make your checkout as smooth as the big chains',
    convBullet3
  );
  all.push(...tb(sConv, 'Mo from Talkin Tacos knows his guests demand easy online ordering.',
    solCapX, solCapY, solCapW, solCapH,
    { fontSize: 9, color: GRAY, font: 'Inter Tight', align: 'CENTER' }).reqs);

  // ── SLIDE 10: Repeat Orders ──────────────────────────────────────────────────
  const sRepeat = slideIds[10];
  all.push(...bgImg(sRepeat, ASSETS.contentBg));
  solutionLeft(sRepeat, 'Grow Repeat Orders', repeatTagline,
    'Get around 2x more reorders with a mobile app',
    'You get a mobile app just like the big chains',
    repeatBullet3
  );
  all.push(...tb(sRepeat, 'Moulino from Phnom Penh Noodle Shack loves seeing his mobile app driving reorders.',
    solCapX, solCapY, solCapW, solCapH,
    { fontSize: 9, color: GRAY, font: 'Inter Tight', align: 'CENTER' }).reqs);

  // ── SLIDE 11: TAP (static full-bleed image) ──────────────────────────────────
  const sTap = slideIds[11];
  all.push(...bgImg(sTap, 'https://raw.githubusercontent.com/davelocity/deckgen/refs/heads/main/slide-tap.png'));

  // ── SLIDE 12: Social Proof (static full-bleed image) ─────────────────────────
  const sSocialProof = slideIds[12];
  all.push(...bgImg(sSocialProof, 'https://github.com/davelocity/deckgen/blob/main/slide-social_proof.jpg?raw=true'));

  // NOTE: createVideo calls are sent in dedicated batchUpdates after the main loop
  // (Google Slides API rejects createVideo when mixed with other request types)
  // Build a video request for the right half of a solution slide
  const makeVideoReq = (pageId, driveId) => ({
    createVideo: {
      objectId: 'vid_' + Math.random().toString(36).slice(2, 9),
      elementProperties: {
        pageObjectId: pageId,
        size: {
          width:  { magnitude: solVidW, unit: 'EMU' },
          height: { magnitude: solVidH, unit: 'EMU' }
        },
        transform: { scaleX: 1, scaleY: 1, translateX: solVidX, translateY: solVidY, unit: 'EMU' }
      },
      source: 'DRIVE',
      id: driveId
    }
  });

  const visVideoReq = makeVideoReq(sVis, '1WZbcQKyF6aTv8vr0V0fPSzrbERy4BtaJ');

  // Post-diagnosis slides (Platform, Approach, Social Proof, Next Steps) are
  // temporarily commented out while we finalise the diagnosis section.

  // ── Execute in chunks with rate-limit-aware retry ────────────────────────────
  // Log image URLs for debugging
  all.forEach((req, i) => {
    if (req.createImage) console.log(`  [${i}] createImage: ${req.createImage.url}`);
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isRateLimit = e => (e.message || '').toLowerCase().includes('quota exceeded');

  // Send a batch; on rate-limit errors use exponential backoff and retry.
  // On non-rate-limit errors throw so the caller can fall back to one-by-one.
  const sendBatch = async (reqs, maxAttempts = 4) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await slidesApi.presentations.batchUpdate({
          presentationId: presId,
          requestBody: { requests: reqs }
        });
        return; // success
      } catch (e) {
        if (isRateLimit(e) && attempt < maxAttempts - 1) {
          const wait = (attempt + 1) * 2000; // 2 s, 4 s, 6 s
          console.log(`Rate limit hit (attempt ${attempt + 1}), waiting ${wait}ms…`);
          await sleep(wait);
        } else {
          throw e; // non-rate-limit or exhausted retries
        }
      }
    }
  };

  // Smaller chunks (20) reduce the chance of hitting the quota ceiling per call
  for (let i = 0; i < all.length; i += 20) {
    const chunk = all.slice(i, i + 20);
    try {
      await sendBatch(chunk);
    } catch (e) {
      if (isRateLimit(e)) {
        // Still throttled after retries — log and skip rather than hammering the API further
        console.log(`Rate limit: skipping chunk [${i}–${i + chunk.length - 1}] after retries`);
      } else {
        // Non-rate-limit failure (e.g. bad image URL) — retry each request individually
        console.log(`Chunk [${i}–${i + chunk.length - 1}] failed (${e.message}), retrying individually`);
        for (let j = 0; j < chunk.length; j++) {
          try {
            await sendBatch([chunk[j]]);
            await sleep(50); // tiny pause between individual calls
          } catch (e2) {
            const label = chunk[j].createImage?.url || Object.keys(chunk[j])[0];
            console.log(`  Skipped request[${i + j}] (${label}): ${e2.message}`);
          }
        }
      }
    }
    // Brief pause between chunks to stay well under the per-minute write limit
    if (i + 20 < all.length) await sleep(150);
  }

  // ── Dedicated createVideo calls (must be isolated — cannot be batched with other types) ──
  const videoRequests = [
    { req: visVideoReq,                                                          label: 'Visibility'    },
    { req: makeVideoReq(sConv,   '1r_BY3jGdMG0fKHTzy326-A0m9qLHO-Ne'),          label: 'Conversion'    },
    { req: makeVideoReq(sRepeat, '1M38qQm1S0wdJbkra1npI_cdj_hIKvEtY'),          label: 'Repeat Orders' },
  ];

  for (const { req, label } of videoRequests) {
    try {
      await slidesApi.presentations.batchUpdate({
        presentationId: presId,
        requestBody: { requests: [req] }
      });
      console.log(`Video embedded: ${label}`);
    } catch (e) {
      console.error(`createVideo failed (${label}):`, e.message);
    }
  }

  return `https://docs.google.com/presentation/d/${presId}/edit`;
}

// ─── Generate API Route ─────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const formData = { ...req.body };                                 // shallow copy so we can normalise
    formData.restaurantName = toTitleCase((formData.restaurantName || '').trim());
    const { restaurantName, websiteUrl, repName, dealNotes } = formData;
    if (!restaurantName || !repName || !dealNotes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let websiteData = { text: '', title: restaurantName, description: '', success: false };
    let screenshots = { desktop: null };
    let prospectLogoUrl = null;
    if (websiteUrl) {
      [websiteData, screenshots, prospectLogoUrl] = await Promise.all([
        scrapeWebsite(websiteUrl),
        fetchScreenshots(websiteUrl),
        fetchLogo(websiteUrl)
      ]);
      // If OpenBrand returned nothing or a blurry result, fall back to apple-touch-icon from the site
      if (!prospectLogoUrl && websiteData.siteLogoUrl) {
        prospectLogoUrl = websiteData.siteLogoUrl;
        console.log('Logo fallback: using site apple-touch-icon:', prospectLogoUrl);
      }
    }

    const deckContent = await generateDeckContent(formData, websiteData);

    let auth;
    try {
      auth = await getAuthorizedClient();
    } catch (e) {
      return res.status(401).json({ error: 'NOT_AUTHORIZED' });
    }

    // Merge website-detected tech stack with AI-extracted platforms from deal notes
    // Dedup by name (case-insensitive) so the same tool never appears twice
    const siteTechStack = websiteData.techStack || [];
    const notesTechStack = Array.isArray(deckContent.techStackFromNotes)
      ? deckContent.techStackFromNotes.filter(t => t && t.name && t.domain)
      : [];
    const seenNames  = new Set(siteTechStack.map(t => t.name.toLowerCase()));
    const seenDomains = new Set(siteTechStack.map(t => t.domain.toLowerCase()));
    const mergedTechStack = [
      ...siteTechStack,
      ...notesTechStack.filter(t =>
        !seenNames.has(t.name.toLowerCase()) &&
        !seenDomains.has(t.domain.toLowerCase())
      )
    ];
    console.log('Merged tech stack:', mergedTechStack.map(t => t.name).join(', ') || 'none');

    const deckUrl = await buildGoogleSlides(deckContent, formData, auth, screenshots, prospectLogoUrl, mergedTechStack);
    res.json({ success: true, url: deckUrl, title: deckContent.deckTitle });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate deck' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Owner Deck Generator running at http://localhost:${PORT}`));