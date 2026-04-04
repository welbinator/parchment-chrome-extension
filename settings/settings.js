// settings.js

const MODELS = {
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini — fast & cheap (recommended)' },
    { value: 'gpt-4o', label: 'GPT-4o — most capable' },
  ],
  anthropic: [
    { value: 'claude-haiku-3-5', label: 'Claude Haiku 3.5 — fast & cheap (recommended)' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 — most capable' },
  ],
  google: [
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash — fast & free tier (recommended)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro — most capable free tier model' },
  ],
};

const aiEnabled = document.getElementById('aiEnabled');
const aiFields = document.getElementById('aiFields');
const providerRadios = document.querySelectorAll('input[name="aiProvider"]');
const modelField = document.getElementById('modelField');
const aiModel = document.getElementById('aiModel');
const toast = document.getElementById('toast');

aiEnabled.addEventListener('change', () => {
  aiFields.classList.toggle('visible', aiEnabled.checked);
});

providerRadios.forEach(radio => {
  radio.addEventListener('change', () => updateModelDropdown(radio.value));
});

function updateModelDropdown(provider) {
  const models = MODELS[provider] || [];
  aiModel.innerHTML = models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
  modelField.style.display = models.length ? 'block' : 'none';
}

// ── Key testing ──────────────────────────────────────────────────────────────

function setStatus(el, type, msg) {
  el.textContent = msg;
  el.className = `key-status ${type}`;
}

document.getElementById('testParchment').addEventListener('click', async () => {
  const key = document.getElementById('parchmentApiKey').value.trim();
  const status = document.getElementById('parchmentStatus');
  if (!key) { setStatus(status, 'err', '✗ Enter a key first'); return; }
  setStatus(status, 'checking', 'Checking…');
  try {
    const res = await fetch('https://theparchment.app/functions/v1/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ action: 'list_collections' }),
    });
    if (res.ok) setStatus(status, 'ok', '✓ Key is valid');
    else setStatus(status, 'err', `✗ Invalid key (${res.status})`);
  } catch (e) {
    setStatus(status, 'err', `✗ Network error: ${e.message}`);
  }
});

document.getElementById('testTranscript').addEventListener('click', async () => {
  const key = document.getElementById('transcriptApiKey').value.trim();
  const status = document.getElementById('transcriptStatus');
  if (!key) { setStatus(status, 'err', '✗ Enter a key first'); return; }
  setStatus(status, 'checking', 'Checking…');
  try {
    // Test with a known short public video
    const res = await fetch(
      'https://transcriptapi.com/api/v2/youtube/transcript?video_url=dQw4w9WgXcQ&format=json',
      { headers: { 'Authorization': `Bearer ${key}` } }
    );
    if (res.ok) setStatus(status, 'ok', '✓ Key is valid');
    else if (res.status === 401) setStatus(status, 'err', '✗ Invalid key');
    else setStatus(status, 'err', `✗ Error ${res.status}`);
  } catch (e) {
    setStatus(status, 'err', `✗ Network error: ${e.message}`);
  }
});

document.getElementById('testAI').addEventListener('click', async () => {
  const key = document.getElementById('aiApiKey').value.trim();
  const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || '';
  const status = document.getElementById('aiStatus');
  if (!key) { setStatus(status, 'err', '✗ Enter a key first'); return; }
  if (!provider) { setStatus(status, 'err', '✗ Select a provider first'); return; }
  setStatus(status, 'checking', 'Checking…');
  try {
    let ok = false;
    let errMsg = '';
    if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
      );
      ok = res.ok;
      if (!ok) errMsg = `${res.status}`;
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      ok = res.ok;
      if (!ok) errMsg = `${res.status}`;
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      ok = res.ok;
      if (!ok) errMsg = `${res.status}`;
    }
    if (ok) setStatus(status, 'ok', '✓ Key is valid');
    else setStatus(status, 'err', `✗ Invalid key${errMsg ? ` (${errMsg})` : ''}`);
  } catch (e) {
    setStatus(status, 'err', `✗ Network error: ${e.message}`);
  }
});

// ── Load / Save ──────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await chrome.storage.sync.get([
    'parchmentApiKey', 'transcriptApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel'
  ]);
  if (s.parchmentApiKey) document.getElementById('parchmentApiKey').value = s.parchmentApiKey;
  if (s.transcriptApiKey) document.getElementById('transcriptApiKey').value = s.transcriptApiKey;
  if (s.aiEnabled) {
    aiEnabled.checked = true;
    aiFields.classList.add('visible');
  }
  if (s.aiProvider) {
    const radio = document.querySelector(`input[name="aiProvider"][value="${s.aiProvider}"]`);
    if (radio) radio.checked = true;
    updateModelDropdown(s.aiProvider);
  }
  if (s.aiModel) aiModel.value = s.aiModel;
  if (s.aiApiKey) document.getElementById('aiApiKey').value = s.aiApiKey;
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const parchmentApiKey = document.getElementById('parchmentApiKey').value.trim();
  const transcriptApiKey = document.getElementById('transcriptApiKey').value.trim();
  const enabled = aiEnabled.checked;
  const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || '';
  const model = aiModel.value;
  const aiApiKey = document.getElementById('aiApiKey').value.trim();

  if (parchmentApiKey && !parchmentApiKey.startsWith('pmt_')) {
    showToast('Parchment API key should start with pmt_', 'error');
    return;
  }

  await chrome.storage.sync.set({ parchmentApiKey, transcriptApiKey, aiEnabled: enabled, aiProvider: provider, aiModel: model, aiApiKey });
  showToast('Settings saved!', 'success');
});

function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

loadSettings();
