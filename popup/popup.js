// popup.js

const stateIdleRecipe     = document.getElementById('stateIdleRecipe');
const stateIdleYouTube    = document.getElementById('stateIdleYouTube');
const stateDetecting      = document.getElementById('stateDetecting');
const stateSuccess        = document.getElementById('stateSuccess');
const stateError          = document.getElementById('stateError');
const detectingMsg        = document.getElementById('detectingMsg');
const successTitle        = document.getElementById('successTitle');
const successCollection   = document.getElementById('successCollection');
const aiBadge             = document.getElementById('aiBadge');
const errorMsg            = document.getElementById('errorMsg');
const errorSetupBtn       = document.getElementById('errorSetupBtn');
const aiNote              = document.getElementById('aiNote');

const allStates = [stateIdleRecipe, stateIdleYouTube, stateDetecting, stateSuccess, stateError];

function showState(el) {
  allStates.forEach(s => s.classList.remove('visible'));
  el.classList.add('visible');
}

function openSettings() { chrome.runtime.openOptionsPage(); }
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('footerSettings').addEventListener('click', openSettings);
errorSetupBtn.addEventListener('click', openSettings);

// ── Init: detect page type ────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await chrome.storage.sync.get(['parchmentApiKey', 'transcriptApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey']);

  let isYT = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'isYouTube' });
    isYT = res?.isYouTube || false;
  } catch (e) {
    // content script not injected yet — inject it
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      const res = await chrome.tabs.sendMessage(tab.id, { action: 'isYouTube' });
      isYT = res?.isYouTube || false;
    } catch {}
  }

  if (isYT) {
    const hasAI = settings.aiEnabled && settings.aiApiKey;
    const hasTranscriptKey = !!settings.transcriptApiKey;
    aiNote.textContent = !hasTranscriptKey
      ? '⚠️ Add a TranscriptAPI.com key in Settings'
      : hasAI
        ? `AI summary via ${settings.aiProvider || 'AI'}`
        : 'Add an AI key in Settings to get summaries';
    showState(stateIdleYouTube);
  } else {
    showState(stateIdleRecipe);
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

  let extracted;
  try {
    extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractRecipe' });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractRecipe' });
    } catch {
      showState(stateError);
      errorMsg.textContent = 'Could not access this page. Try reloading it.';
      return;
    }
  }

  if (extracted.source === 'raw') detectingMsg.textContent = 'No recipe schema found — asking AI…';

  const result = await chrome.runtime.sendMessage({ action: 'saveRecipe', data: extracted, tabId: tab.id });

  if (result.success) {
    successTitle.textContent = result.title;
    successCollection.textContent = `Saved to ${result.collection}`;
    aiBadge.style.display = 'none';
    showState(stateSuccess);
  } else {
    showState(stateError);
    errorMsg.textContent = result.error;
    if (result.error.includes('API key') || result.error.includes('Settings')) {
      errorSetupBtn.style.display = 'inline-block';
    }
  }
});

// ── YouTube save ──────────────────────────────────────────────────────────

async function doYouTubeSave(withAI) {
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

  let data;
  try {
    data = await chrome.tabs.sendMessage(tab.id, { action: 'extractYouTube' });
  } catch (e) {
    showState(stateError);
    errorMsg.textContent = 'Could not access the page. Try reloading the video.';
    return;
  }

  if (withAI && data.transcript) detectingMsg.textContent = 'Summarizing with AI…';

  // Pass withAI flag — service worker checks settings but we override for transcript-only
  const payload = withAI ? data : { ...data, _skipAI: true };
  const result = await chrome.runtime.sendMessage({ action: 'saveYouTube', data: payload });

  if (result.success) {
    successTitle.textContent = result.title;
    successCollection.textContent = `Saved to ${result.collection}`;
    aiBadge.style.display = result.hadSummary ? 'inline-block' : 'none';
    showState(stateSuccess);
  } else {
    showState(stateError);
    errorMsg.textContent = result.error;
    if (result.error.includes('API key') || result.error.includes('Settings')) {
      errorSetupBtn.style.display = 'inline-block';
    }
  }
}

document.getElementById('saveBtnYouTubeFull').addEventListener('click', () => doYouTubeSave(true));
document.getElementById('saveBtnYouTubeTranscript').addEventListener('click', () => doYouTubeSave(false));
