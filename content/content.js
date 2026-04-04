// content.js — runs on every page, extracts recipe or YouTube video metadata when asked

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

  const title = document.querySelector('h1.ytd-video-primary-info-renderer, h1[class*="title"]')?.innerText?.trim()
    || document.title.replace(' - YouTube', '').trim();

  const channelName = document.querySelector('#channel-name a, ytd-channel-name a')?.innerText?.trim() || '';

  // Transcript is fetched by the service worker via TranscriptAPI.com
  return {
    source: 'youtube',
    videoId,
    title,
    channelName,
    url: location.href,
  };
}

// ── Recipe ───────────────────────────────────────────────────────────────────

function extractRecipe() {
  const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      const recipe = findRecipeInSchema(data);
      if (recipe) return { source: 'schema', recipe };
    } catch (e) {}
  }

  const heuristic = scrapeHeuristic();
  if (heuristic) return { source: 'heuristic', recipe: heuristic };

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
  return {
    name, url,
    description: schema.description || '',
    totalTime: schema.totalTime || schema.cookTime || '',
    yield: schema.recipeYield || schema.yield || '',
    ingredients, instructions,
  };
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
    return true;
  }
  if (msg.action === 'isYouTube') {
    sendResponse({ isYouTube: isYouTube() });
  }
  return true;
});
