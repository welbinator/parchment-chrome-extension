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

async function getOrCreateCollection(apiKey, name) {
  const { collections } = await parchmentRequest(apiKey, { action: 'list_collections' });
  const existing = collections.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const created = await parchmentRequest(apiKey, { action: 'create_collection', name });
  return created.collection.id;
}

async function savePageWithBlocks(apiKey, collectionId, title, blocks) {
  const page = await parchmentRequest(apiKey, {
    action: 'create_page',
    collection_id: collectionId,
    title,
  });
  await parchmentRequest(apiKey, {
    action: 'replace_blocks',
    page_id: page.page.id,
    blocks,
  });
  return page.page.id;
}

// ── Recipe ─────────────────────────────────────────────────────────────────

function buildRecipeBlocks(recipe) {
  const blocks = [];
  if (recipe.url) blocks.push({ type: 'text', content: `Source: ${recipe.url}` });
  if (recipe.description) blocks.push({ type: 'text', content: recipe.description });
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
      if (step.startsWith('—') && step.endsWith('—')) {
        blocks.push({ type: 'text', content: step });
      } else {
        blocks.push({ type: 'text', content: `${i + 1}. ${step}` });
      }
    });
  }
  return blocks;
}

// ── YouTube ─────────────────────────────────────────────────────────────────

function msToTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildYouTubeBlocks(data, summary) {
  const blocks = [];

  blocks.push({ type: 'text', content: `Source: ${data.url}` });
  if (data.channelName) blocks.push({ type: 'text', content: `Channel: ${data.channelName}` });
  blocks.push({ type: 'divider' });

  if (summary) {
    blocks.push({ type: 'heading2', content: 'Summary' });
    // Split summary into paragraphs
    const paragraphs = summary.split(/\n+/).filter(Boolean);
    for (const p of paragraphs) {
      if (p.startsWith('- ') || p.startsWith('• ')) {
        blocks.push({ type: 'text', content: p });
      } else {
        blocks.push({ type: 'text', content: p });
      }
    }
    blocks.push({ type: 'divider' });
  }

  if (data.transcript?.length > 0) {
    blocks.push({ type: 'heading2', content: 'Transcript' });
    // Group transcript into ~30 second chunks to avoid hitting 10KB block limit
    let chunk = '';
    let chunkStartMs = data.transcript[0].startMs;

    for (const seg of data.transcript) {
      const segText = seg.text + ' ';
      if (chunk.length + segText.length > 800) {
        const ts = msToTimestamp(chunkStartMs);
        blocks.push({ type: 'text', content: `[${ts}] ${chunk.trim()}` });
        chunk = segText;
        chunkStartMs = seg.startMs;
      } else {
        chunk += segText;
      }
    }
    if (chunk.trim()) {
      const ts = msToTimestamp(chunkStartMs);
      blocks.push({ type: 'text', content: `[${ts}] ${chunk.trim()}` });
    }
  }

  return blocks;
}

async function summarizeTranscript(transcript, title, settings) {
  if (!settings.aiEnabled || !settings.aiApiKey) return null;

  const fullText = transcript.map(s => s.text).join(' ');
  // Trim to ~12k chars to stay within model context limits
  const trimmed = fullText.slice(0, 12000);

  const prompt = `You are a helpful assistant that creates concise, useful notes from YouTube video transcripts.

Video title: "${title}"

Transcript:
${trimmed}

Create a structured summary with:
1. A 2-3 sentence overview of what the video covers
2. Key points as bullet points (use "- " prefix)
3. Any important tips, warnings, or takeaways

Keep it concise and practical. Do not include filler phrases like "In this video..." or "The creator says...". Just the useful information.`;

  try {
    if (settings.aiProvider === 'openai') {
      return await callOpenAI(settings.aiApiKey, settings.aiModel || 'gpt-4o-mini', prompt);
    } else if (settings.aiProvider === 'anthropic') {
      return await callAnthropic(settings.aiApiKey, settings.aiModel || 'claude-haiku-3-5', prompt);
    }
  } catch (e) {
    console.error('AI summarization failed:', e);
    return null;
  }
}

// ── AI helpers ───────────────────────────────────────────────────────────────

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
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
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
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

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
    let text;
    if (settings.aiProvider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.aiApiKey}` },
        body: JSON.stringify({ model: settings.aiModel || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      });
      const d = await res.json();
      text = d.choices[0].message.content;
    } else if (settings.aiProvider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': settings.aiApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: settings.aiModel || 'claude-haiku-3-5', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await res.json();
      text = d.content[0].text;
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    parsed.url = '';
    return parsed;
  } catch (e) {
    console.error('AI extraction failed:', e);
    return null;
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'saveRecipe') {
    handleSaveRecipe(msg.data, msg.tabId).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  if (msg.action === 'saveYouTube') {
    handleSaveYouTube(msg.data).then(sendResponse).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  if (msg.action === 'fetchTranscript') {
    handleFetchTranscript(msg.baseUrl).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleFetchTranscript(baseUrl) {
  // Try JSON3 first, fallback to XML
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
  if (!xml || xml.trim().length === 0) throw new Error('No transcript data returned.');

  // Parse XML manually (no DOM parser in service worker)
  const segments = [];
  const regex = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const startMs = Math.round(parseFloat(match[1]) * 1000);
    const text = match[2]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '').trim();
    if (text) segments.push({ startMs, text });
  }

  if (segments.length === 0) throw new Error('Transcript was empty or could not be parsed.');
  return { segments };
}

async function handleSaveRecipe(extracted, tabId) {
  const settings = await chrome.storage.sync.get(['parchmentApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel']);
  if (!settings.parchmentApiKey) return { success: false, error: 'No Parchment API key set. Open Settings to add one.' };

  let recipe;
  if (extracted.source === 'schema' || extracted.source === 'heuristic') {
    recipe = extracted.recipe;
    recipe.url = recipe.url || '';
  } else {
    if (!settings.aiEnabled || !settings.aiApiKey) {
      return { success: false, error: "Couldn't detect a recipe on this page. Enable AI in Settings to extract recipes from any site." };
    }
    recipe = await extractRecipeWithAI(extracted, settings);
    if (!recipe) return { success: false, error: 'AI extraction failed. The page may not contain a recipe.' };
    recipe.url = extracted.url || '';
  }

  const collectionId = await getOrCreateCollection(settings.parchmentApiKey, 'Recipes');
  const blocks = buildRecipeBlocks(recipe);
  const pageId = await savePageWithBlocks(settings.parchmentApiKey, collectionId, recipe.name, blocks);
  return { success: true, title: recipe.name, pageId, collection: 'Recipes' };
}

async function handleSaveYouTube(data) {
  const settings = await chrome.storage.sync.get(['parchmentApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel']);
  if (!settings.parchmentApiKey) return { success: false, error: 'No Parchment API key set. Open Settings to add one.' };

  if (data.transcriptError && !data.transcript) {
    return { success: false, error: `Couldn't get transcript: ${data.transcriptError}` };
  }

  // Summarize if AI is enabled and not skipped
  let summary = null;
  if (!data._skipAI && settings.aiEnabled && settings.aiApiKey && data.transcript) {
    summary = await summarizeTranscript(data.transcript, data.title, settings);
  }

  const collectionId = await getOrCreateCollection(settings.parchmentApiKey, 'YouTube Videos');
  const blocks = buildYouTubeBlocks(data, summary);
  const pageId = await savePageWithBlocks(settings.parchmentApiKey, collectionId, data.title, blocks);

  return { success: true, title: data.title, pageId, collection: 'YouTube Videos', hadSummary: !!summary };
}
