// content.js — runs on every page, extracts recipe data when asked

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
    html: document.body.innerText.slice(0, 15000), // trim to avoid huge payloads
    title: document.title,
    url: location.href,
  };
}

function findRecipeInSchema(data) {
  // Handle array of schemas
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findRecipeInSchema(item);
      if (r) return r;
    }
    return null;
  }

  // Handle @graph
  if (data['@graph']) {
    return findRecipeInSchema(data['@graph']);
  }

  if (data['@type'] === 'Recipe' || (Array.isArray(data['@type']) && data['@type'].includes('Recipe'))) {
    return normalizeSchema(data);
  }

  return null;
}

function normalizeSchema(schema) {
  const name = schema.name || document.title;
  const url = location.href;

  // Ingredients
  const rawIngredients = schema.recipeIngredient || schema.ingredients || [];
  const ingredients = rawIngredients.map(i => (typeof i === 'string' ? i : i.name || String(i)));

  // Instructions
  let instructions = [];
  const rawInstructions = schema.recipeInstructions || schema.instructions || [];
  if (Array.isArray(rawInstructions)) {
    for (const step of rawInstructions) {
      if (typeof step === 'string') {
        instructions.push(step);
      } else if (step['@type'] === 'HowToStep') {
        instructions.push(step.text || step.name || '');
      } else if (step['@type'] === 'HowToSection') {
        // Sections with nested steps
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

  // Meta
  const description = schema.description || '';
  const totalTime = schema.totalTime || schema.cookTime || '';
  const yield_ = schema.recipeYield || schema.yield || '';

  return { name, url, description, totalTime, yield: yield_, ingredients, instructions };
}

function scrapeHeuristic() {
  const name = document.querySelector('h1')?.innerText?.trim() || document.title;

  // Find ingredients: look for lists near words like "ingredient"
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

  // Find instructions: look for ordered lists or divs near "instruction/direction/step"
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

// Listen for message from popup/background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extractRecipe') {
    sendResponse(extractRecipe());
  }
  return true;
});
