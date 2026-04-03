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
};

const aiEnabled = document.getElementById('aiEnabled');
const aiFields = document.getElementById('aiFields');
const providerRadios = document.querySelectorAll('input[name="aiProvider"]');
const modelField = document.getElementById('modelField');
const aiModel = document.getElementById('aiModel');
const toast = document.getElementById('toast');

// Show/hide AI fields based on toggle
aiEnabled.addEventListener('change', () => {
  aiFields.classList.toggle('visible', aiEnabled.checked);
});

// Update model dropdown when provider changes
providerRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    updateModelDropdown(radio.value);
  });
});

function updateModelDropdown(provider) {
  const models = MODELS[provider] || [];
  aiModel.innerHTML = models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
  modelField.style.display = models.length ? 'block' : 'none';
}

// Load saved settings
async function loadSettings() {
  const s = await chrome.storage.sync.get([
    'parchmentApiKey', 'aiEnabled', 'aiProvider', 'aiApiKey', 'aiModel'
  ]);

  if (s.parchmentApiKey) document.getElementById('parchmentApiKey').value = s.parchmentApiKey;
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

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const parchmentApiKey = document.getElementById('parchmentApiKey').value.trim();
  const enabled = aiEnabled.checked;
  const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || '';
  const model = aiModel.value;
  const aiApiKey = document.getElementById('aiApiKey').value.trim();

  if (parchmentApiKey && !parchmentApiKey.startsWith('pmt_')) {
    showToast('Parchment API key should start with pmt_', 'error');
    return;
  }

  await chrome.storage.sync.set({
    parchmentApiKey,
    aiEnabled: enabled,
    aiProvider: provider,
    aiModel: model,
    aiApiKey,
  });

  showToast('Settings saved!', 'success');
});

function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

loadSettings();
