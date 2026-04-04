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

  // Fetch transcript via YouTube's timedtext API
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
  // YouTube embeds captions track info in ytInitialPlayerResponse
  // We extract the timedtext URL from there
  const scripts = [...document.querySelectorAll('script')];
  let playerResponse = null;

  for (const script of scripts) {
    const text = script.textContent || '';
    if (text.includes('ytInitialPlayerResponse')) {
      const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (match) {
        try { playerResponse = JSON.parse(match[1]); break; } catch (e) {}
      }
    }
  }

  if (!playerResponse) throw new Error('Could not find player data on page. Try reloading the video.');

  const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) throw new Error('No captions available for this video.');

  // Prefer English, fallback to first available
  const track = captions.find(t => t.languageCode === 'en' && !t.kind)
    || captions.find(t => t.languageCode === 'en')
    || captions[0];

  if (!track?.baseUrl) throw new Error('No usable caption track found.');

  // Fetch the XML transcript
  const res = await fetch(track.baseUrl + '&fmt=json3');
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`);
  const data = await res.json();

  // Parse into flat array of { start, text } objects
  const events = data.events || [];
  const segments = [];
  for (const event of events) {
    if (!event.segs) continue;
    const startMs = event.tStartMs || 0;
    const text = event.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
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
