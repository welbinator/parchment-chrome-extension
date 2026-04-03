// popup.js

const stateIdle = document.getElementById('stateIdle');
const stateDetecting = document.getElementById('stateDetecting');
const stateSuccess = document.getElementById('stateSuccess');
const stateError = document.getElementById('stateError');
const detectingMsg = document.getElementById('detectingMsg');
const saveBtn = document.getElementById('saveBtn');
const successName = document.getElementById('successName');
const sourceBadge = document.getElementById('sourceBadge');
const errorMsg = document.getElementById('errorMsg');
const errorSetupBtn = document.getElementById('errorSetupBtn');

function showState(name) {
  [stateIdle, stateDetecting, stateSuccess, stateError].forEach(el => el.classList.remove('visible'));
  document.getElementById('state' + name).classList.add('visible');
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('footerSettings').addEventListener('click', openSettings);
errorSetupBtn.addEventListener('click', openSettings);

saveBtn.addEventListener('click', async () => {
  // Check for API key first
  const settings = await chrome.storage.sync.get(['parchmentApiKey']);
  if (!settings.parchmentApiKey) {
    showState('Error');
    errorMsg.textContent = 'No Parchment API key set. Open Settings to add one.';
    errorSetupBtn.style.display = 'inline-block';
    return;
  }

  showState('Detecting');
  detectingMsg.textContent = 'Detecting recipe…';

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Ask content script to extract recipe
  let extracted;
  try {
    extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractRecipe' });
  } catch (e) {
    // Content script not injected — try injecting it manually then retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
      extracted = await chrome.tabs.sendMessage(tab.id, { action: 'extractRecipe' });
    } catch (e2) {
      showState('Error');
      errorMsg.textContent = 'Could not access this page. Make sure you\'re on a recipe page and try reloading the tab first.';
      return;
    }
  }

  const sourceLabels = { schema: 'Detected via Schema.org', heuristic: 'Detected via page scan', raw: 'Detected via AI' };

  if (extracted.source === 'raw') {
    detectingMsg.textContent = 'No recipe schema found — asking AI…';
  }

  // Send to background to handle Parchment API calls
  const result = await chrome.runtime.sendMessage({
    action: 'saveRecipe',
    data: extracted,
    tabId: tab.id,
  });

  if (result.success) {
    showState('Success');
    successName.textContent = result.recipeName;
    sourceBadge.textContent = sourceLabels[extracted.source] || '';
  } else {
    showState('Error');
    errorMsg.textContent = result.error;
    if (result.error.includes('API key') || result.error.includes('Settings')) {
      errorSetupBtn.style.display = 'inline-block';
    }
  }
});
