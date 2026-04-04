// content.js — runs on every page, extracts recipe or YouTube video data when asked

// ── YouTube ──────────────────────────────────────────────────────────────────

function isYouTube() {
  return location.hostname.includes('youtube.com') && location.pathname === '/watch';
}

function getVideoId() {
  return new URLSearchParams(location.search).get('v');
}

async function extractYouTubeData() {
  const videoId = getVideoId();
  if (!videoId) return { source: 'youtube-error', error: 'No video ID found in URL.' };

  // Get video title and description from the page
  const title = document.querySelector('h1.ytd-video-primary-info-renderer, h1[class*="title"]')?.innerText?.trim()
    || document.title.replace(' - YouTube', '').trim();

  const channelName = document.querySelector('#channel-name a, ytd-channel-name a')?.innerText?.trim() || '';

  // Fetch transcript from page context (has YouTube Referer, no CORS issues)
  let transcript = null;
  let transcriptError = null;
  try {
    transcript = await fetchTranscript(videoId);
  } catch (e) {
    transcriptError = e.message;
  }

  return {
    source: 'youtube',
    videoId,
    title,
    channelName,
    url: location.href,
    transcript,
    transcriptError,
  };
}

async function fetchTranscript(videoId) {
  // Parse ytInitialPlayerResponse from inline script tags
  // YouTube embeds it in several possible formats
  let playerResponse = null;
  const scripts = [...document.querySelectorAll('script')];

  for (const script of scripts) {
    const text = script.textContent || '';
    if (!text.includes('ytInitialPlayerResponse')) continue;

    // Try to find just the captions section to avoid giant JSON parse
    const captionsIdx = text.indexOf('playerCaptionsTracklistRenderer');
    if (captionsIdx === -1) continue;

    // Walk back to find the opening brace of ytInitialPlayerResponse
    const varIdx = text.lastIndexOf('ytInitialPlayerResponse', captionsIdx);
    if (varIdx === -1) continue;

    // Find where the value starts (after = or :)
    const valueStart = text.indexOf('{', varIdx);
    if (valueStart === -1) continue;

    // Balance braces to find end of object
    let depth = 0, i = valueStart, end = -1;
    while (i < text.length && i < valueStart + 2000000) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      i++;
    }
    if (end === -1) continue;

    try {
      playerResponse = JSON.parse(text.slice(valueStart, end + 1));
      break;
    } catch (e) {}
  }

  if (!playerResponse) {
    throw new Error('Could not find YouTube player data. Please reload the video page and try again.');
  }

  const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error('No captions available for this video.');
  }

  const track = captions.find(t => t.languageCode === 'en' && !t.kind)
    || captions.find(t => t.languageCode === 'en')
    || captions[0];

  if (!track?.baseUrl) throw new Error('No usable caption track found.');

  const result = await fetchTranscriptFromPage(track.baseUrl);
  return result.segments;
}

function getPlayerResponseFromWindow() {
  return Promise.resolve(null); // unused
}

async function fetchTranscriptXML(baseUrl) {
  const res = await fetch(baseUrl);
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`);
  const xml = await res.text();
  if (!xml || xml.trim().length === 0) throw new Error('No transcript data returned.');

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const textNodes = doc.querySelectorAll('text');

  if (textNodes.length === 0) throw new Error('No captions found in transcript.');

  const segments = [];
  for (const node of textNodes) {
    const startMs = Math.round(parseFloat(node.getAttribute('start') || '0') * 1000);
    const raw = node.textContent || '';
    // Decode HTML entities
    const text = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (text) segments.push({ startMs, text });
  }

  return segments;
}

// ── Recipe ───────────────────────────────────────────────────────────────────

function extractRecipe() {
  // Strategy 1: Schema.org JSON-LD
  const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      const recipe = findRecipeInSchema(data);
      if (recipe) return { source: 'schema', recipe };
    } catch (e) {}
  }

  // Strategy 2: Heuristic scraping
  const heuristic = scrapeHeuristic();
  if (heuristic) return { source: 'heuristic', recipe: heuristic };

  // Strategy 3: Return raw HTML for AI fallback
  return {
    source: 'raw',
    html: document.body.innerText.slice(0, 15000),
    title: document.title,
    url: location.href,
  };
}

function findRecipeInSchema(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findRecipeInSchema(item);
      if (r) return r;
    }
    return null;
  }
  if (data['@graph']) return findRecipeInSchema(data['@graph']);
  if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) {
    return normalizeSchema(data);
  }
  return null;
}

function normalizeSchema(schema) {
  const name = schema.name || document.title;
  const url = location.href;
  const rawIngredients = schema.recipeIngredient || schema.ingredients || [];
  const ingredients = rawIngredients.map(i => (typeof i === 'string' ? i : i.name || String(i)));
  let instructions = [];
  const rawInstructions = schema.recipeInstructions || schema.instructions || [];
  if (Array.isArray(rawInstructions)) {
    for (const step of rawInstructions) {
      if (typeof step === 'string') {
        instructions.push(step);
      } else if (step['@type'] === 'HowToStep') {
        instructions.push(step.text || step.name || '');
      } else if (step['@type'] === 'HowToSection') {
        const sectionName = step.name || '';
        const sectionSteps = step.itemListElement || [];
        if (sectionName) instructions.push(`— ${sectionName} —`);
        for (const s of sectionSteps) {
          instructions.push(typeof s === 'string' ? s : s.text || s.name || '');
        }
      }
    }
  } else if (typeof rawInstructions === 'string') {
    instructions = rawInstructions.split(/\n+/).filter(Boolean);
  }
  const description = schema.description || '';
  const totalTime = schema.totalTime || schema.cookTime || '';
  const yield_ = schema.recipeYield || schema.yield || '';
  return { name, url, description, totalTime, yield: yield_, ingredients, instructions };
}

function scrapeHeuristic() {
  const name = document.querySelector('h1')?.innerText?.trim() || document.title;
  let ingredients = [];
  const allLists = [...document.querySelectorAll('ul, ol')];
  for (const list of allLists) {
    const context = list.closest('section, div, article');
    const contextText = context?.className + ' ' + context?.id + ' ' +
      (context?.previousElementSibling?.innerText || '') +
      (list.previousElementSibling?.innerText || '');
    if (/ingredient/i.test(contextText)) {
      ingredients = [...list.querySelectorAll('li')].map(li => li.innerText.trim()).filter(Boolean);
      if (ingredients.length > 0) break;
    }
  }
  let instructions = [];
  for (const list of allLists) {
    const context = list.closest('section, div, article');
    const contextText = context?.className + ' ' + context?.id + ' ' +
      (context?.previousElementSibling?.innerText || '') +
      (list.previousElementSibling?.innerText || '');
    if (/instruction|direction|step|method|preparation/i.test(contextText)) {
      instructions = [...list.querySelectorAll('li')].map(li => li.innerText.trim()).filter(Boolean);
      if (instructions.length > 0) break;
    }
  }
  if (ingredients.length === 0 && instructions.length === 0) return null;
  return { name, url: location.href, ingredients, instructions, description: '' };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extractRecipe') {
    sendResponse(extractRecipe());
  }
  if (msg.action === 'extractYouTube') {
    extractYouTubeData().then(sendResponse);
    return true; // async
  }
  if (msg.action === 'isYouTube') {
    sendResponse({ isYouTube: isYouTube() });
  }
  return true;
});

async function fetchTranscriptFromPage(baseUrl) {
  // Try JSON3
  const jsonRes = await fetch(baseUrl + '&fmt=json3');
  if (jsonRes.ok) {
    const text = await jsonRes.text();
    if (text && text.trim().length > 0) {
      try {
        const data = JSON.parse(text);
        const events = data.events || [];
        const segments = [];
        for (const event of events) {
          if (!event.segs) continue;
          const startMs = event.tStartMs || 0;
          const t = event.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
          if (t) segments.push({ startMs, text: t });
        }
        if (segments.length > 0) return { segments };
      } catch (e) {}
    }
  }

  // XML fallback
  const xmlRes = await fetch(baseUrl);
  if (!xmlRes.ok) throw new Error(`Transcript fetch failed: ${xmlRes.status}`);
  const xml = await xmlRes.text();
  if (!xml || xml.trim().length === 0) throw new Error('No transcript data returned from YouTube.');

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const textNodes = doc.querySelectorAll('text');
  if (textNodes.length === 0) throw new Error('No captions found in transcript XML.');

  const segments = [];
  for (const node of textNodes) {
    const startMs = Math.round(parseFloat(node.getAttribute('start') || '0') * 1000);
    const raw = node.textContent || '';
    const text = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (text) segments.push({ startMs, text });
  }

  if (segments.length === 0) throw new Error('Transcript parsed but no segments found.');
  return { segments };
}
