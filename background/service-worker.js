// service-worker.js — handles API calls to Parchment and AI providers

const PARCHMENT_API = 'https://theparchment.app/functions/v1/api';

// ── Parchment API helpers ──────────────────────────────────────────────────

async function parchmentRequest(apiKey, body) {
  let res;
  try {
    res = await fetch(PARCHMENT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Network error calling Parchment API: ${e.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error || j.message || ''; } catch {}
    throw new Error(`Parchment API error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

async function getOrCreateRecipesCollection(apiKey) {
  const { collections } = await parchmentRequest(apiKey, { action: 'list_collections' });
  const existing = collections.find(c => c.name.toLowerCase() === 'recipes');
  if (existing) return existing.id;

  const created = await parchmentRequest(apiKey, { action: 'create_collection', name: 'Recipes' });
  return created.collection.id;
}

async function saveRecipeToPage(apiKey, collectionId, recipe) {
  const page = await parchmentRequest(apiKey, {
    action: 'create_page',
    collection_id: collectionId,
    title: recipe.name,
  });
  const pageId = page.page.id;

  const blocks = buildBlocks(recipe);
  await parchmentRequest(apiKey, {
    action: 'replace_blocks',
    page_id: pageId,
    blocks,
  });

  return pageId;
}

function buildBlocks(recipe) {
  const blocks = [];

  if (recipe.url) {
    blocks.push({ type: 'text', content: `Source: ${recipe.url}` });
  }

  if (recipe.description) {
    blocks.push({ type: 'text', content: recipe.description });
  }

  if (recipe.totalTime || recipe.yield) {
    const meta = [
      recipe.totalTime ? `Time: ${recipe.totalTime}` : '',
      recipe.yield ? `Yield: ${recipe.yield}` : '',
    ].filter(Boolean).join('  |  ');
    blocks.push({ type: 'text', content: meta });
  }

  blocks.push({ type: 'divider' });

  if (recipe.ingredients?.length > 0) {
    blocks.push({ type: 'heading2', content: 'Ingredients' });
    for (const ing of recipe.ingredients) {
      blocks.push({ type: 'todo', content: ing });
    }
  }

  if (recipe.instructions?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'heading2', content: 'Instructions' });
    recipe.instructions.forEach((step, i) => {
      // Section headers (e.g. "— Sauce —") render as text
      if (step.startsWith('—') && step.endsWith('—')) {
        blocks.push({ type: 'text', content: step });
      } else {
        blocks.push({ type: 'text', content: `${i + 1}. ${step}` });
      }
    });
  }

  return blocks;
}

// ── AI fallback ─────────────────────────────────────────────────────────────

async function extractRecipeWithAI(rawData, settings) {
  if (!settings.aiEnabled || !settings.aiApiKey) return null;

  const prompt = `Extract the recipe from the following page text. Return ONLY valid JSON with this exact shape:
{
  "name": "Recipe name",
  "description": "Brief description or empty string",
  "totalTime": "cook time or empty string",
  "yield": "servings or empty string",
  "ingredients": ["ingredient 1", "ingredient 2"],
  "instructions": ["step 1", "step 2"]
}

Page title: ${rawData.title}
Page URL: ${rawData.url}

Page text:
${rawData.html}`;

  try {
    if (settings.aiProvider === 'openai') {
      return await callOpenAI(settings.aiApiKey, settings.aiModel || 'gpt-4o-mini', prompt);
    } else if (settings.aiProvider === 'anthropic') {
      return await callAnthropic(settings.aiApiKey, settings.aiModel || 'claude-haiku-3-5', prompt);
    }
  } catch (e) {
    console.error('AI extraction failed:', e);
    return null;
  }
}

async function callOpenAI(apiKey, model, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
  const data = await res.json();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text);
  parsed.url = '';
  return parsed;
}

async function callAnthropic(apiKey, model, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
  const data = await res.json();
  const text = data.content[0].text;
  // Extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Anthropic response');
  const parsed = JSON.parse(jsonMatch[0]);
  parsed.url = '';
  return parsed;
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'saveRecipe') {
    handleSaveRecipe(msg.data, msg.tabId).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // keep channel open for async
  }
});

async function handleSaveRecipe(extracted, tabId) {
  const settings = await chrome.storage.sync.get([
    'parchmentApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel'
  ]);

  if (!settings.parchmentApiKey) {
    return { success: false, error: 'No Parchment API key set. Open Settings to add one.' };
  }

  let recipe;

  if (extracted.source === 'schema' || extracted.source === 'heuristic') {
    recipe = extracted.recipe;
    recipe.url = recipe.url || '';
  } else {
    // Raw HTML — try AI
    if (!settings.aiEnabled || !settings.aiApiKey) {
      return {
        success: false,
        error: "Couldn't detect a recipe on this page. Enable AI in Settings to extract recipes from any site.",
      };
    }
    recipe = await extractRecipeWithAI(extracted, settings);
    if (!recipe) {
      return { success: false, error: 'AI extraction failed. The page may not contain a recipe.' };
    }
    recipe.url = extracted.url || '';
  }

  const collectionId = await getOrCreateRecipesCollection(settings.parchmentApiKey);
  const pageId = await saveRecipeToPage(settings.parchmentApiKey, collectionId, recipe);

  return { success: true, recipeName: recipe.name, pageId };
}
