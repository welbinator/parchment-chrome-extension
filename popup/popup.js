// popup.js

const stateIdleRecipe   = document.getElementById('stateIdleRecipe');
const stateIdleYouTube  = document.getElementById('stateIdleYouTube');
const stateIdleArticle  = document.getElementById('stateIdleArticle');
const stateDetecting    = document.getElementById('stateDetecting');
const stateSuccess      = document.getElementById('stateSuccess');
const stateError        = document.getElementById('stateError');
const detectingMsg      = document.getElementById('detectingMsg');
const successTitle      = document.getElementById('successTitle');
const successCollection = document.getElementById('successCollection');
const aiBadge           = document.getElementById('aiBadge');
const errorMsg          = document.getElementById('errorMsg');
const errorSetupBtn     = document.getElementById('errorSetupBtn');
const aiNote            = document.getElementById('aiNote');
const aiNoteArticle     = document.getElementById('aiNoteArticle');

const allStates = [stateIdleRecipe, stateIdleYouTube, stateIdleArticle, stateDetecting, stateSuccess, stateError];

function showState(el) {
  allStates.forEach(s => s.classList.remove('visible'));
  el.classList.add('visible');
}

function openSettings() { chrome.runtime.openOptionsPage(); }
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('footerSettings').addEventListener('click', openSettings);
errorSetupBtn.addEventListener('click', openSettings);

// ── Helpers ───────────────────────────────────────────────────────────────

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  }
}

function showResult(result) {
  if (result.success) {
    successTitle.textContent = result.title;
    successCollection.textContent = `Saved to ${result.collection}`;
    if (result.hadSummary) {
      aiBadge.style.display = 'inline-block';
      aiBadge.textContent = '✨ AI summary included';
      aiBadge.style.color = '';
      aiBadge.style.background = '';
    } else if (result.summaryError) {
      aiBadge.style.display = 'inline-block';
      aiBadge.textContent = `⚠️ AI failed: ${result.summaryError}`;
      aiBadge.style.color = '#c0392b';
      aiBadge.style.background = '#fdecea';
    } else {
      aiBadge.style.display = 'none';
    }
    // Deep-link to the newly created page
    const openBtn = document.getElementById('openBtn');
    const base = 'https://theparchment.app';
    openBtn.href = result.pageId ? `${base}?page=${result.pageId}` : base;
    showState(stateSuccess);
  } else {
    showState(stateError);
    errorMsg.textContent = result.error;
    errorSetupBtn.style.display =
      (result.error.includes('API key') || result.error.includes('Settings')) ? 'inline-block' : 'none';
  }
}

// ── Init: detect page type ────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await chrome.storage.sync.get(['parchmentApiKey', 'transcriptApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey']);
  const hasAI = !!(settings.aiEnabled && settings.aiApiKey);

  await ensureContentScript(tab.id).catch(() => {});

  let isYT = false;
  let isRecipe = false;

  try {
    const ytRes = await chrome.tabs.sendMessage(tab.id, { action: 'isYouTube' });
    isYT = ytRes?.isYouTube || false;
  } catch {}

  if (!isYT) {
    try {
      const recipeRes = await chrome.tabs.sendMessage(tab.id, { action: 'isRecipe' });
      isRecipe = recipeRes?.isRecipe || false;
    } catch {}
  }

  if (isYT) {
    const hasTranscriptKey = !!settings.transcriptApiKey;
    aiNote.textContent = !hasTranscriptKey
      ? '⚠️ Add a TranscriptAPI.com key in Settings'
      : hasAI
        ? `AI summary via ${settings.aiProvider || 'AI'}`
        : 'Add an AI key in Settings to get summaries';
    showState(stateIdleYouTube);
  } else if (isRecipe) {
    showState(stateIdleRecipe);
  } else {
    // Generic article/page — AI will determine if it's a recipe during save
    const hint = isRecipe === false && hasAI
      ? `AI will detect page type automatically`
      : hasAI
        ? `Summarized via ${settings.aiProvider || 'AI'}`
        : '⚠️ Add an AI key in Settings to enable summaries';
    aiNoteArticle.textContent = hasAI
      ? `AI will detect page type & summarize via ${settings.aiProvider || 'AI'}`
      : '⚠️ Add an AI key in Settings to enable summaries';
    document.getElementById('saveBtnArticle').disabled = !hasAI;
    showState(stateIdleArticle);
  }
}

init();

// ── Recipe save ───────────────────────────────────────────────────────────

document.getElementById('saveBtnRecipe').addEventListener('click', async () => {
  const settings = await chrome.storage.sync.get(['parchmentApiKey']);
  if (!settings.parchmentApiKey) {
    showState(stateError);
    errorMsg.textContent = 'No Parchment API key set. Open Settings to add one.';
    errorSetupBtn.style.display = 'inline-block';
    return;
  }

  showState(stateDetecting);
  detectingMsg.textContent = 'Detecting recipe…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await ensureContentScript(tab.id);

  let extracted;
  try {
    extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractRecipe' });
  } catch {
    showState(stateError);
    errorMsg.textContent = 'Could not access this page. Try reloading it.';
    return;
  }

  if (extracted.source === 'raw') detectingMsg.textContent = 'No recipe schema found — asking AI…';

  const result = await chrome.runtime.sendMessage({ action: 'saveRecipe', data: extracted, tabId: tab.id });
  showResult(result);
});

// ── YouTube save ──────────────────────────────────────────────────────────

async function doYouTubeSave(mode) {
  // mode: 'summaryOnly' | 'summaryAndTranscript' | 'transcriptOnly'
  const settings = await chrome.storage.sync.get(['parchmentApiKey']);
  if (!settings.parchmentApiKey) {
    showState(stateError);
    errorMsg.textContent = 'No Parchment API key set. Open Settings to add one.';
    errorSetupBtn.style.display = 'inline-block';
    return;
  }

  showState(stateDetecting);
  detectingMsg.textContent = 'Fetching transcript…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await ensureContentScript(tab.id);

  let data;
  try {
    data = await chrome.tabs.sendMessage(tab.id, { action: 'extractYouTube' });
  } catch {
    showState(stateError);
    errorMsg.textContent = 'Could not access the page. Try reloading the video.';
    return;
  }

  if (mode !== 'transcriptOnly') detectingMsg.textContent = 'Summarizing with AI…';

  const payload = { ...data, _saveMode: mode };
  const result = await chrome.runtime.sendMessage({ action: 'saveYouTube', data: payload });
  showResult(result);
}

document.getElementById('saveBtnYouTubeSummaryOnly').addEventListener('click', () => doYouTubeSave('summaryOnly'));
document.getElementById('saveBtnYouTubeFull').addEventListener('click', () => doYouTubeSave('summaryAndTranscript'));
document.getElementById('saveBtnYouTubeTranscript').addEventListener('click', () => doYouTubeSave('transcriptOnly'));

// ── Article save ──────────────────────────────────────────────────────────

async function doArticleSave(withAI) {
  const settings = await chrome.storage.sync.get(['parchmentApiKey']);
  if (!settings.parchmentApiKey) {
    showState(stateError);
    errorMsg.textContent = 'No Parchment API key set. Open Settings to add one.';
    errorSetupBtn.style.display = 'inline-block';
    return;
  }

  showState(stateDetecting);
  detectingMsg.textContent = withAI ? 'Analyzing page…' : 'Saving page…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await ensureContentScript(tab.id);

  let extracted;
  try {
    extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractArticle' });
  } catch {
    showState(stateError);
    errorMsg.textContent = 'Could not access this page. Try reloading it.';
    return;
  }

  if (withAI) detectingMsg.textContent = 'AI is classifying & summarizing…';

  const payload = withAI ? extracted : { ...extracted, _skipAI: true };
  const result = await chrome.runtime.sendMessage({ action: 'saveArticle', data: payload });
  showResult(result);
}

document.getElementById('saveBtnArticle').addEventListener('click', () => doArticleSave(true));
document.getElementById('saveBtnArticleRaw').addEventListener('click', () => doArticleSave(false));
