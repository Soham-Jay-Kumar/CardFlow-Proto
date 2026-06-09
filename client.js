const cardInput = document.getElementById('cardInput');
const reviewSection = document.getElementById('reviewSection');
const feedback = document.getElementById('feedback');
const statusText = document.getElementById('statusText');
const fileLabelText = document.getElementById('fileLabelText');
const previewContainer = document.getElementById('previewContainer');
const cardPreview = document.getElementById('cardPreview');
const fileName = document.getElementById('fileName');
const dataTableContainer = document.getElementById('dataTableContainer');
const dataTableBody = document.getElementById('dataTableBody');
const extractionStatus = document.getElementById('extractionStatus');
const signInButton = document.getElementById('signInButton');
const signOutButton = document.getElementById('signOutButton');
const spreadsheetIdInput = document.getElementById('spreadsheetIdInput');
const exportToSheetsButton = document.getElementById('exportToSheetsButton');
const sheetStatus = document.getElementById('sheetStatus');
const fileDrop = document.querySelector('.file-drop');
const copyButton = document.getElementById('copyButton');
const refreshCardButton = document.getElementById('refreshCardButton');
const cardQueue = document.getElementById('cardQueue');

const AUTH_STATUS_URL = `${window.location.origin}/api/auth/status`;
const GOOGLE_CONFIG_URL = `${window.location.origin}/api/google-config`;
const EXPORT_SHEET_URL = `${window.location.origin}/api/export-to-sheet`;
const PLACEHOLDER_SHEET_IDS = new Set([
  'YOUR_SHEET_ID_HERE',
  'your-spreadsheet-id-from-url',
  'your-spreadsheet-id',
]);

let isOAuthConfigured = false;
let isUserAuthenticated = false;
let authenticatedUserEmail = '';

const FEEDBACK_STORAGE_KEY = 'cardFlowProCorrections';
const CONTACT_FIELDS = ['name', 'position', 'company', 'address', 'phone', 'email'];
const EXTRACT_API_URL = `${window.location.origin}/extract`;
let currentRawText = '';
let lastParsedData = null;
let correctionTimer = null;
let cardRecords = [];
let activeCardIndex = 0;
let isProcessingBatch = false;
let isReanalyzing = false;

function normalizeKey(value) {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cardFingerprint(rawText) {
  const normalized = normalizeKey(rawText);
  if (!normalized) {
    return '';
  }
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash * 33) ^ normalized.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}-${normalized.length}`;
}

function loadCorrections() {
  try {
    const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY);
    if (!raw) {
      return { version: 2, byCard: {} };
    }
    const parsed = JSON.parse(raw);
    return {
      version: 2,
      byCard: parsed.byCard || {},
    };
  } catch {
    return { version: 2, byCard: {} };
  }
}

function saveCorrections(store) {
  localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(store));
}

function getCardCorrectionBucket(store, rawText, create = false) {
  const fp = cardFingerprint(rawText);
  if (!fp) {
    return null;
  }
  if (!store.byCard[fp] && create) {
    store.byCard[fp] = { fieldMaps: {}, lineMaps: {} };
  }
  return store.byCard[fp] || null;
}

/** Apply corrections only for this card's OCR text — never bleed across different cards. */
function applyLearnedCorrections(parsedData, rawText) {
  const fp = cardFingerprint(rawText);
  if (!fp) {
    return cloneCardData(parsedData);
  }

  const store = loadCorrections();
  const bucket = getCardCorrectionBucket(store, rawText, false);
  if (!bucket) {
    return cloneCardData(parsedData);
  }

  const result = cloneCardData(parsedData);

  CONTACT_FIELDS.forEach((field) => {
    const extracted = (parsedData[field] || '').trim();
    if (!extracted) {
      return;
    }
    const maps = bucket.fieldMaps[field] || {};
    const corrected = maps[extracted] || maps[normalizeKey(extracted)];
    if (corrected) {
      result[field] = corrected;
    }
  });

  const lines = (rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  lines.forEach((line) => {
    const lineKey = normalizeKey(line);
    const lineCorrection = bucket.lineMaps[lineKey];
    if (!lineCorrection) {
      return;
    }
    CONTACT_FIELDS.forEach((field) => {
      if (lineCorrection[field]) {
        result[field] = lineCorrection[field];
      }
    });
  });

  return result;
}

function saveLearnedCorrections(rawText, parsedData, userData) {
  if (!parsedData || !cardFingerprint(rawText)) {
    return;
  }

  const store = loadCorrections();
  const bucket = getCardCorrectionBucket(store, rawText, true);
  let changed = false;

  CONTACT_FIELDS.forEach((field) => {
    const extracted = (parsedData[field] || '').trim();
    const corrected = (userData[field] || '').trim();
    if (!extracted || !corrected || extracted === corrected) {
      return;
    }

    if (!bucket.fieldMaps[field]) {
      bucket.fieldMaps[field] = {};
    }
    if (bucket.fieldMaps[field][extracted] !== corrected) {
      bucket.fieldMaps[field][extracted] = corrected;
      bucket.fieldMaps[field][normalizeKey(extracted)] = corrected;
      changed = true;
    }
  });

  const lines = (rawText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  lines.forEach((line) => {
    const lineKey = normalizeKey(line);
    CONTACT_FIELDS.forEach((field) => {
      const extracted = (parsedData[field] || '').trim();
      const corrected = (userData[field] || '').trim();
      if (!corrected || extracted === corrected || normalizeKey(extracted) !== lineKey) {
        return;
      }

      if (!bucket.lineMaps[lineKey]) {
        bucket.lineMaps[lineKey] = {};
      }
      if (bucket.lineMaps[lineKey][field] !== corrected) {
        bucket.lineMaps[lineKey][field] = corrected;
        changed = true;
      }
    });
  });

  if (changed) {
    saveCorrections(store);
  }
}

function scheduleCorrectionSave() {
  clearTimeout(correctionTimer);
  correctionTimer = setTimeout(() => {
    const record = cardRecords[activeCardIndex];
    if (!record?.lastParsedData) {
      return;
    }
    saveLearnedCorrections(record.rawText, record.lastParsedData, cloneCardData(record.data));
  }, 500);
}

function syncAllTableCells() {
  if (!dataTableBody) {
    return;
  }

  dataTableBody.querySelectorAll('tr').forEach((row) => {
    const index = Number(row.dataset.cardIndex);
    const record = cardRecords[index];
    if (!record) {
      return;
    }

    CONTACT_FIELDS.forEach((field) => {
      const cell = row.querySelector(`[data-field="${field}"]`);
      if (cell) {
        record.data[field] = cell.textContent.trim();
      }
    });
    record.data = cloneCardData(record.data);
  });
}

function updateActiveRowHighlight() {
  if (!dataTableBody) {
    return;
  }

  dataTableBody.querySelectorAll('tr').forEach((row) => {
    row.classList.toggle('is-active', Number(row.dataset.cardIndex) === activeCardIndex);
  });
}

function handleCellInput(index, field) {
  const record = cardRecords[index];
  if (!record) {
    return;
  }

  const cell = dataTableBody?.querySelector(
    `tr[data-card-index="${index}"] [data-field="${field}"]`,
  );
  if (!cell) {
    return;
  }

  record.data[field] = cell.textContent.trim();
  record.data = cloneCardData(record.data);

  if (field === 'name') {
    renderCardQueue();
  }

  if (index === activeCardIndex) {
    scheduleCorrectionSave();
  }
}

function handleCellPaste(event) {
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain').replace(/\r?\n+/g, ' ').trim();
  document.execCommand('insertText', false, text);
}

function createEmptyCardData() {
  return Object.fromEntries(CONTACT_FIELDS.map((field) => [field, '']));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function persistActiveCardForm() {
  syncAllTableCells();
}

function selectCard(index, options = {}) {
  if (index < 0 || index >= cardRecords.length) {
    return;
  }

  syncAllTableCells();
  activeCardIndex = index;
  const record = cardRecords[index];
  currentRawText = record.rawText || '';
  lastParsedData = record.lastParsedData;

  if (record.imageData) {
    cardPreview.src = record.imageData;
    previewContainer.classList.remove('hidden');
  }
  fileName.textContent = record.fileName;
  renderCardQueue();

  if (options.refreshTable === false) {
    updateActiveRowHighlight();
  } else {
    renderTableFromRecords();
  }

  statusText.textContent = `Step 2 — ${cardRecords.length} card(s) in table`;
  updateRefreshButtonState();
}

function renderCardQueue() {
  if (!cardQueue) {
    return;
  }
  if (cardRecords.length === 0) {
    cardQueue.classList.add('hidden');
    cardQueue.innerHTML = '';
    return;
  }

  cardQueue.classList.remove('hidden');
  cardQueue.innerHTML = cardRecords.map((record, index) => {
    const label = record.data?.name?.trim() || record.fileName;
    const statusLabel = record.status === 'processing'
      ? 'Processing'
      : record.status === 'error'
        ? 'Needs review'
        : 'Ready';
    return `
      <button type="button" class="card-queue-item ${index === activeCardIndex ? 'is-active' : ''} status-${record.status}" data-index="${index}">
        <img src="${record.thumbData || record.imageData || ''}" alt="" />
        <span class="card-queue-label">${escapeHtml(label)}</span>
        <span class="card-queue-status">${statusLabel}</span>
      </button>
    `;
  }).join('');

  cardQueue.querySelectorAll('.card-queue-item').forEach((button) => {
    button.addEventListener('click', () => selectCard(Number(button.dataset.index)));
  });
}

function renderTableFromRecords() {
  if (!dataTableBody) {
    return;
  }

  dataTableBody.innerHTML = '';
  cardRecords.forEach((record, index) => {
    const row = document.createElement('tr');
    row.dataset.cardIndex = String(index);
    if (index === activeCardIndex) {
      row.classList.add('is-active');
    }

    const data = record.data;
    CONTACT_FIELDS.forEach((field) => {
      const cell = document.createElement('td');
      cell.className = 'data-table-cell';
      cell.dataset.field = field;
      cell.contentEditable = 'true';
      cell.spellcheck = false;
      cell.textContent = data[field] || '';
      cell.addEventListener('focus', () => {
        if (activeCardIndex !== index) {
          selectCard(index, { refreshTable: false });
        }
      });
      cell.addEventListener('input', () => handleCellInput(index, field));
      cell.addEventListener('paste', handleCellPaste);
      row.appendChild(cell);
    });

    dataTableBody.appendChild(row);
  });

  if (cardRecords.length > 0) {
    dataTableContainer.classList.remove('hidden');
  }
}

function cloneCardData(data) {
  return Object.fromEntries(
    CONTACT_FIELDS.map((field) => [field, (data?.[field] || '').trim()]),
  );
}


function sanitizeCardsForSheet(cards) {
  const formatter = window.CardFlowSheetFormat;
  if (!formatter?.sanitizeCardForSheet) {
    return cards;
  }
  return cards.map((card) => formatter.sanitizeCardForSheet(card));
}

function copyToClipboard() {
  syncAllTableCells();

  if (!cardRecords.length) {
    feedback.textContent = 'No contact data to copy. Upload a card first.';
    feedback.className = 'toast is-error';
    return;
  }

  const formatter = window.CardFlowSheetFormat;
  const escapeCell = formatter?.escapeSpreadsheetPasteCell
    || ((value, field) => String(value ?? '').trim());
  const toTsv = formatter?.rowsToClipboardTsv
    || ((rows) => rows.map((row) => row.join('\t')).join('\n'));

  const headerLabels = ['Name', 'Position', 'Company', 'Address', 'Phone number', 'Email'];
  const rows = [headerLabels];
  const cards = sanitizeCardsForSheet(cardRecords.map((record) => cloneCardData(record.data)));

  cards.forEach((card) => {
    rows.push(CONTACT_FIELDS.map((field) => escapeCell(card[field], field)));
  });

  navigator.clipboard.writeText(toTsv(rows)).then(() => {
    copyButton.textContent = 'Copied';
    feedback.textContent = 'Table data copied to clipboard.';
    feedback.className = 'toast is-success';
    setTimeout(() => {
      copyButton.textContent = 'Copy table to clipboard';
      feedback.textContent = '';
      feedback.className = 'toast';
    }, 3000);
  }).catch((err) => {
    console.error('Failed to copy: ', err);
    copyButton.textContent = 'Copy failed';
    feedback.textContent = 'Failed to copy to clipboard.';
    feedback.className = 'toast is-error';
    setTimeout(() => {
      copyButton.textContent = 'Copy table to clipboard';
      feedback.textContent = '';
      feedback.className = 'toast';
    }, 3000);
  });
}

async function loadAuthStatus() {
  try {
    const response = await fetch(AUTH_STATUS_URL, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Auth status failed (${response.status})`);
    }
    const status = await response.json();
    isUserAuthenticated = Boolean(status.authenticated);
    isOAuthConfigured = Boolean(status.oauthConfigured);
    authenticatedUserEmail = status.email || '';
    updateSheetControls();
  } catch (error) {
    console.warn('Could not load auth status:', error);
    isUserAuthenticated = false;
    if (sheetStatus) {
      sheetStatus.textContent =
        'Cannot reach server. Run "npm start" in the project folder, then open http://localhost:3000';
    }
  }
}

async function loadGoogleConfigFromServer() {
  if (sheetStatus) {
    sheetStatus.textContent = 'Checking Google sign-in...';
  }

  try {
    const response = await fetch(GOOGLE_CONFIG_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Config request failed (${response.status})`);
    }
    const config = await response.json();
    isOAuthConfigured = Boolean(config.oauthConfigured || config.methods?.oauthExport);
    window.__cardflowRedirectUri = config.redirectUri || '';
    window.__cardflowOAuthSetup = config;
    await loadAuthStatus();
    updateSheetMethodStatus();
  } catch (error) {
    console.warn('Could not load Google config:', error);
    isOAuthConfigured = false;
    if (sheetStatus) {
      sheetStatus.textContent =
        'Cannot reach server. Run "npm start" in the project folder, then open http://localhost:3000';
    }
  }
}

function updateSheetMethodStatus() {
  if (!sheetStatus) {
    return;
  }

  const hasSheetId = spreadsheetIdInput?.value.trim().length > 0;

  if (!isOAuthConfigured) {
    sheetStatus.textContent =
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and SESSION_SECRET in .env, then restart npm start.';
    return;
  }

  if (isUserAuthenticated) {
    const who = authenticatedUserEmail ? `Signed in as ${authenticatedUserEmail}.` : 'Signed in with Google.';
    sheetStatus.textContent = hasSheetId
      ? `${who} Paste a spreadsheet URL if needed, then use Export to Sheets above the table.`
      : `${who} Paste your spreadsheet URL, then export from the output table.`;
    return;
  }

  sheetStatus.textContent = 'Login with Google to export contacts to your spreadsheet.';
}

function updateSheetControls() {
  const signedIn = isUserAuthenticated;
  const hasSheetId = spreadsheetIdInput?.value.trim().length > 0;

  if (signInButton) {
    signInButton.classList.toggle('hidden', signedIn || !isOAuthConfigured);
    if (!isOAuthConfigured) {
      signInButton.setAttribute('aria-disabled', 'true');
      signInButton.classList.add('is-disabled');
    } else {
      signInButton.removeAttribute('aria-disabled');
      signInButton.classList.remove('is-disabled');
    }
  }

  if (signOutButton) {
    signOutButton.classList.toggle('hidden', !signedIn);
  }

  if (exportToSheetsButton) {
    exportToSheetsButton.classList.toggle('hidden', !signedIn);
    exportToSheetsButton.disabled = !signedIn || !hasSheetId;
  }

  if (signedIn && hasSheetId) {
    updateSheetMethodStatus();
  }
}

function handleSignOut() {
  window.location.href = '/auth/logout';
}

function getSpreadsheetId() {
  const input = spreadsheetIdInput.value.trim();
  if (!input) {
    return '';
  }

  if (input.includes('docs.google.com/spreadsheets/d/')) {
    const match = input.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const id = match?.[1] || '';
    return PLACEHOLDER_SHEET_IDS.has(id) ? '' : id;
  }

  if (PLACEHOLDER_SHEET_IDS.has(input)) {
    return '';
  }

  return input;
}

function hasContactData(card) {
  return CONTACT_FIELDS.some((field) => String(card?.[field] ?? '').trim());
}

function formatExportValidationErrors(body, cards = []) {
  if (body?.code !== 'VALIDATION_FAILED' || !Array.isArray(body.invalidCards) || !body.invalidCards.length) {
    return body?.error || 'Export failed.';
  }

  const detailLines = body.invalidCards.map(({ index, validation }) => {
    const contactLabel = cards[index]?.name?.trim() || `Contact ${index + 1}`;
    const issueText = (validation?.issues || [])
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join('; ');
    return `${contactLabel} — ${issueText || 'validation failed'}`;
  });

  return `${body.error} ${detailLines.join(' | ')}`;
}

async function saveToGoogleSheet() {
  if (!isUserAuthenticated) {
    const message = 'Login with Google before exporting to Sheets.';
    if (sheetStatus) {
      sheetStatus.textContent = message;
    }
    feedback.textContent = message;
    feedback.className = 'toast is-error';
    return;
  }

  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) {
    const raw = spreadsheetIdInput.value.trim();
    const message = PLACEHOLDER_SHEET_IDS.has(raw)
      ? 'Paste your real Google Spreadsheet URL (the ID is between /d/ and /edit).'
      : 'Paste your Google Spreadsheet URL first.';
    sheetStatus.textContent = message;
    feedback.textContent = message;
    feedback.className = 'toast is-error';
    return;
  }

  syncAllTableCells();
  const cards = cardRecords
    .map((record) => cloneCardData(record.data))
    .filter(hasContactData);

  if (!cards.length) {
    const message = 'No contact data to save. Upload a card and fill in the table first.';
    sheetStatus.textContent = message;
    feedback.textContent = message;
    feedback.className = 'toast is-error';
    return;
  }

  if (exportToSheetsButton) {
    exportToSheetsButton.disabled = true;
  }
  sheetStatus.textContent = `Saving ${cards.length} row(s)...`;

  try {
    const response = await fetch(EXPORT_SHEET_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId, cards }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        isUserAuthenticated = false;
        updateSheetControls();
      }
      const message = formatExportValidationErrors(body, cards);
      throw new Error(message);
    }
    const message = `${body.rowsWritten || cards.length} contact(s) saved to your Google Sheet.`;
    sheetStatus.textContent = message;
    feedback.textContent = 'Contacts saved to Google Sheet.';
    feedback.className = 'toast is-success';
  } catch (error) {
    console.error('Save to Google Sheet error:', error);
    sheetStatus.textContent = error.message || 'Could not save to Google Sheet.';
    feedback.textContent = sheetStatus.textContent;
    feedback.className = 'toast is-error';
  } finally {
    updateSheetControls();
  }
}

function handleAuthRedirectMessage() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  if (!auth) {
    return;
  }

  if (auth === 'success') {
    feedback.textContent = 'Signed in with Google. You can export contacts to your spreadsheet.';
    feedback.className = 'toast is-success';
  } else if (auth === 'failed' || auth === 'error') {
    const reason = params.get('reason') || '';
    if (reason === 'access_denied') {
      feedback.textContent =
        'Google blocked sign-in (403 access_denied). Add your Gmail under OAuth consent screen → Test users, enable Google Sheets API, then sign in with that same account.';
    } else if (reason === 'UserInfoError') {
      feedback.textContent =
        'Google sign-in failed while loading your profile. Restart npm start, sign in again, and allow all requested permissions (email, profile, Sheets).';
    } else {
      feedback.textContent = 'Google sign-in failed. Restart npm start and try again. If it persists, verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env match Google Cloud Console.';
    }
    if (sheetStatus) {
      sheetStatus.textContent = feedback.textContent;
    }
    feedback.className = 'toast is-error';
  }

  ['auth', 'reason', 'description'].forEach((key) => params.delete(key));
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
  window.history.replaceState({}, '', nextUrl);
}

window.addEventListener('load', async () => {
  handleAuthRedirectMessage();
  await loadGoogleConfigFromServer();
});

const OCR_TARGET_MIN_WIDTH = 1800;
const ORIENTATION_PREVIEW_MAX_WIDTH = 1400;
const OCR_ORIENTATION_MIN_CONFIDENCE = 2;

async function createOcrWorker() {
  const { createWorker } = window.Tesseract;
  const worker = await createWorker('eng');
  await configureOcrWorker(worker);
  return worker;
}

async function configureOcrWorker(worker) {
  const psm = getOcrPsm('AUTO', '3');
  await setOcrPageSegMode(worker, psm);
}

function getOcrPsm(name, fallback) {
  return window.Tesseract?.PSM?.[name] ?? fallback;
}

async function setOcrPageSegMode(worker, psm) {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
}

async function preprocessImageForOcr(imageData) {
  const img = await loadImageElement(imageData);
  const scale = Math.min(3, Math.max(1, OCR_TARGET_MIN_WIDTH / Math.max(img.width, 1)));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    const gray = (0.299 * data[i]) + (0.587 * data[i + 1]) + (0.114 * data[i + 2]);
    const contrast = 1.3;
    const adjusted = Math.min(255, Math.max(0, ((gray - 128) * contrast) + 128));
    data[i] = adjusted;
    data[i + 1] = adjusted;
    data[i + 2] = adjusted;
  }
  ctx.putImageData(pixels, 0, 0);

  return canvas.toDataURL('image/png');
}

async function normalizeImageUpload(imageData) {
  try {
    const blob = await fetch(imageData).then((response) => response.blob());
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.92);
  } catch {
    return imageData;
  }
}

async function orientCardImage(worker, imageData) {
  const { image, rotation } = await resolveUprightImage(worker, imageData);
  return {
    uprightImageData: image,
    rotation,
  };
}

async function analyzeOrientedCard(worker, imageData, { rotateAuto = false } = {}) {
  const result = await worker.recognize(imageData, { rotateAuto });
  return {
    text: result.data.text || '',
    lines: mapOcrLines(result),
  };
}

function scoreOcrResult(ocrResult) {
  const parsed = parseExtractedText(ocrResult);
  const fieldScore =
    (parsed.email ? 40 : 0)
    + (parsed.phone ? 35 : 0)
    + (parsed.name ? 20 : 0)
    + (parsed.company ? 15 : 0)
    + (parsed.position ? 12 : 0)
    + (parsed.address ? 12 : 0);
  const textScore = Math.min((ocrResult.text || '').trim().length, 500) / 20;
  const lineScore = Math.min((ocrResult.lines || []).length, 20);
  const confidenceValues = (ocrResult.lines || [])
    .map((line) => line.confidence)
    .filter((confidence) => Number.isFinite(confidence));
  const confidenceScore = confidenceValues.length
    ? confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length / 10
    : 0;

  return fieldScore + textScore + lineScore + confidenceScore;
}

async function runFinalOcr(worker, uprightImageData) {
  const preprocessedImage = await preprocessImageForOcr(uprightImageData);
  const candidates = [
    { image: preprocessedImage, psm: getOcrPsm('AUTO', '3'), rotateAuto: false },
    { image: preprocessedImage, psm: getOcrPsm('SPARSE_TEXT', '11'), rotateAuto: false },
    { image: preprocessedImage, psm: getOcrPsm('SINGLE_BLOCK', '6'), rotateAuto: false },
    { image: uprightImageData, psm: getOcrPsm('SPARSE_TEXT', '11'), rotateAuto: true },
  ];

  let bestResult = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    await setOcrPageSegMode(worker, candidate.psm);
    const result = await analyzeOrientedCard(worker, candidate.image, {
      rotateAuto: candidate.rotateAuto,
    });
    const score = scoreOcrResult(result);
    if (score > bestScore) {
      bestResult = result;
      bestScore = score;
    }
  }

  return bestResult || { text: '', lines: [] };
}

async function analyzeCardImage(sourceImageData, statusPrefix = '') {
  let worker = null;
  try {
    if (!window.Tesseract) {
      throw new Error('Tesseract not available');
    }

    const normalizedImage = await normalizeImageUpload(sourceImageData);
    worker = await createOcrWorker();

    extractionStatus.classList.remove('hidden');
    extractionStatus.textContent = `${statusPrefix}Orienting card...`;
    const { uprightImageData, rotation } = await orientCardImage(worker, normalizedImage);

    await worker.terminate();
    worker = await createOcrWorker();

    extractionStatus.textContent = `${statusPrefix}Analyzing card...`;
    const ocrResult = await runFinalOcr(worker, uprightImageData);
    ocrResult.uprightImageData = uprightImageData;
    ocrResult.rotation = rotation;

    return { success: true, ocrResult };
  } catch (error) {
    console.error('Card analysis error:', error);
    return { success: false, error };
  } finally {
    extractionStatus.classList.add('hidden');
    if (worker) {
      await worker.terminate();
    }
  }
}

function mapApiExtractToCardData(apiData, sourceText = '') {
  return fixNamePositionOrder({
    name: (apiData?.name || '').trim(),
    position: (apiData?.position || apiData?.job_title || '').trim(),
    company: (apiData?.company || '').trim(),
    address: (apiData?.address || '').trim(),
    phone: (apiData?.phone || '').trim(),
    email: (apiData?.email || '').trim(),
  }, sourceText);
}

async function extractWithApi({ image, text } = {}) {
  const payload = {};
  if (image) {
    payload.base64Image = image;
  }
  if (text?.trim()) {
    payload.text = text.trim();
  }
  if (!payload.image && !payload.text) {
    throw new Error('No image or OCR text available for extraction');
  }

  const response = await fetch(EXTRACT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Extract API failed (${response.status})`);
  }

  const body = await response.json();
  const mapped = mapApiExtractToCardData(body, payload.text || '');
  mapped.validation = body.validation || null;
  mapped.aiValidation = body.aiValidation || null;
  return mapped;
}

function mergePhoneValues(primary, fallback) {
  const formatter = window.CardFlowSheetFormat;
  if (formatter?.mergePhoneValues) {
    return formatter.mergePhoneValues(primary, fallback);
  }

  const primaryTrimmed = String(primary ?? '').trim();
  const fallbackTrimmed = String(fallback ?? '').trim();
  if (!primaryTrimmed) {
    return fallbackTrimmed;
  }
  if (!fallbackTrimmed) {
    return primaryTrimmed;
  }

  const splitParts = (value) => value.split(/\s*\/\s*|[\n;,|]+/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const merged = [];

  for (const part of [...splitParts(primaryTrimmed), ...splitParts(fallbackTrimmed)]) {
    const key = part.replace(/\D/g, '');
    if (key.length >= 7 && !seen.has(key)) {
      seen.add(key);
      merged.push(part);
    }
  }

  return merged.join(' / ');
}

function mergeParsedData(primary, fallback, ocrPayload) {
  const merged = {};
  CONTACT_FIELDS.forEach((field) => {
    if (field === 'phone') {
      return;
    }
    const aiValue = (primary?.[field] || '').trim();
    const localValue = (fallback?.[field] || '').trim();
    merged[field] = aiValue || localValue;
  });

  const ocrEmail = ocrPayload ? extractEmailFromOcr(ocrPayload) : '';
  const aiEmail = extractEmail(primary?.email || '');
  const localEmail = extractEmail(fallback?.email || '');
  merged.email = ocrEmail || aiEmail || localEmail || '';
  merged.phone = mergePhoneValues(primary?.phone, fallback?.phone);

  if (!merged.company) {
    merged.company = companyFromEmail(merged.email) || '';
  }
  return fixNamePositionOrder(merged, ocrPayload?.text || '');
}

async function applyOcrResultToRecord(record, ocrResult) {
  const parsed = await buildCardDataFromOcr(ocrResult);
  record.imageData = ocrResult.uprightImageData;
  record.thumbData = ocrResult.uprightImageData;
  record.rawText = parsed.rawText;
  record.lastParsedData = cloneCardData(parsed.lastParsedData);
  record.data = cloneCardData(parsed.data);
  record.extractionWarning = parsed.extractionWarning || '';
  record.validation = parsed.validation || null;
  record.aiValidation = parsed.aiValidation || null;

  const hasText = Boolean(parsed.rawText?.trim());
  const hasFields = CONTACT_FIELDS.some((field) => parsed.data[field]);
  const needsReview = Boolean(record.validation?.requiresReview);
  record.status = (hasText || hasFields) && !needsReview ? 'done' : 'error';
  return parsed;
}

function updateRefreshButtonState() {
  if (!refreshCardButton) {
    return;
  }
  const record = cardRecords[activeCardIndex];
  const canRefresh = Boolean(
    record?.sourceImageData && !isProcessingBatch && !isReanalyzing,
  );
  refreshCardButton.disabled = !canRefresh;
}

async function buildCardDataFromOcr(ocrResult) {
  const ocrPayload = {
    text: ocrResult.text || '',
    lines: (ocrResult.lines || []).map((line) => ({ ...line })),
  };

  const localParsed = parseExtractedText(ocrPayload);
  let parsed = localParsed;
  let extractionWarning = '';
  let validation = null;
  let aiValidation = null;

  const imageForApi = ocrResult.uprightImageData || ocrResult.imageData || '';
  if (imageForApi || ocrPayload.text.trim()) {
    try {
      const apiParsed = await extractWithApi({
        image: imageForApi || undefined,
        text: ocrPayload.text,
      });
      validation = apiParsed.validation || null;
      aiValidation = apiParsed.aiValidation || null;
      parsed = mergeParsedData(apiParsed, localParsed, ocrPayload);
      if (validation?.requiresReview) {
        extractionWarning = `Validation confidence ${validation.confidence}. Review before saving.`;
      }
    } catch (error) {
      console.warn('AI extraction failed, using rule-based parser:', error);
      extractionWarning = error.message || 'AI extraction unavailable';
    }
  }

  const ocrEmail = extractEmailFromOcr(ocrPayload);
  if (ocrEmail) {
    parsed.email = ocrEmail;
  }

  const lastParsedData = cloneCardData(parsed);
  const data = cloneCardData(
    applyLearnedCorrections(lastParsedData, ocrPayload.text),
  );
  return {
    lastParsedData,
    data,
    rawText: ocrPayload.text,
    extractionWarning,
    validation,
    aiValidation,
  };
}

async function processSingleCard(file, index, total) {
  const record = {
    fileName: file.name,
    sourceImageData: '',
    imageData: '',
    thumbData: '',
    rawText: '',
    lastParsedData: null,
    data: createEmptyCardData(),
    status: 'processing',
  };
  cardRecords.push(record);
  renderCardQueue();
  renderTableFromRecords();

  feedback.textContent = `Processing ${index + 1} of ${total} cards...`;
  feedback.className = 'toast is-info';
  updateRefreshButtonState();

  try {
    record.sourceImageData = await readFileAsDataUrl(file);
    const statusPrefix = `Card ${index + 1} of ${total}: `;
    const { success, ocrResult } = await analyzeCardImage(record.sourceImageData, statusPrefix);

    if (success && ocrResult) {
      console.log(`Card ${index + 1} oriented ${ocrResult.rotation}° before analysis`);
      await applyOcrResultToRecord(record, ocrResult);
      const recordIndex = cardRecords.indexOf(record);
      if (recordIndex === activeCardIndex) {
        currentRawText = record.rawText;
        lastParsedData = record.lastParsedData;
      }
    } else {
      record.status = 'error';
    }
  } catch (error) {
    console.error(`Error processing ${file.name}:`, error);
    record.status = 'error';
  }

  renderCardQueue();
  renderTableFromRecords();
  updateRefreshButtonState();
  return record;
}

async function reanalyzeActiveCard() {
  persistActiveCardForm();
  const record = cardRecords[activeCardIndex];
  const sourceImage = record?.sourceImageData || record?.imageData;

  if (!sourceImage) {
    feedback.textContent = 'No image available to re-analyze for this card.';
    feedback.className = 'toast is-error';
    return;
  }

  if (isProcessingBatch || isReanalyzing) {
    return;
  }

  isReanalyzing = true;
  updateRefreshButtonState();
  record.status = 'processing';
  renderCardQueue();

  feedback.textContent = 'Re-analyzing card from the original image...';
  feedback.className = 'toast is-info';

  const { success, ocrResult } = await analyzeCardImage(sourceImage, 'Re-analyzing: ');

  isReanalyzing = false;

  if (success && ocrResult) {
    if (!record.sourceImageData) {
      record.sourceImageData = sourceImage;
    }
    await applyOcrResultToRecord(record, ocrResult);
    currentRawText = record.rawText;
    lastParsedData = record.lastParsedData;
    cardPreview.src = record.imageData;
    previewContainer.classList.remove('hidden');
    fileName.textContent = record.fileName;
    feedback.textContent = record.extractionWarning
      ? `Re-analysis complete (local parser; AI unavailable: ${record.extractionWarning}).`
      : 'Re-analysis complete. Review the updated table row.';
    feedback.className = 'toast is-success';
  } else {
    record.status = 'error';
    feedback.textContent = 'Re-analysis failed. Try again or edit the table row manually.';
    feedback.className = 'toast is-error';
  }

  renderCardQueue();
  renderTableFromRecords();
  updateRefreshButtonState();
}

async function processFiles(fileList) {
  const imageFiles = Array.from(fileList).filter((file) => file.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    feedback.textContent = 'Please upload image files only.';
    feedback.className = 'toast is-error';
    return;
  }

  if (!window.Tesseract) {
    feedback.textContent = 'Tesseract library not loaded. Please refresh the page.';
    feedback.className = 'toast is-error';
    return;
  }

  persistActiveCardForm();
  const startIndex = cardRecords.length;
  const activeBeforeBatch = activeCardIndex;

  fileLabelText.textContent = 'Add image';
  reviewSection.classList.remove('hidden');
  extractionStatus.classList.remove('hidden');
  isProcessingBatch = true;
  updateRefreshButtonState();
  updateSheetControls();

  try {
    for (let i = 0; i < imageFiles.length; i += 1) {
      await processSingleCard(imageFiles[i], i, imageFiles.length);
    }

    if (cardRecords.length > startIndex) {
      selectCard(startIndex);
    } else if (cardRecords.length > 0) {
      selectCard(Math.min(activeBeforeBatch, cardRecords.length - 1));
    }

    const batchRecords = cardRecords.slice(startIndex);
    const doneCount = batchRecords.filter((record) => record.status === 'done').length;
    const failCount = batchRecords.filter((record) => record.status === 'error').length;
    const totalCount = cardRecords.length;

    const apiWarning = batchRecords.find((record) => record.extractionWarning)?.extractionWarning;

    if (failCount === 0) {
      feedback.textContent = apiWarning
        ? `Added ${doneCount} card(s) using local parser (AI unavailable: ${apiWarning}).`
        : `Added ${doneCount} card(s). ${totalCount} total — edit cells in the table below.`;
      feedback.className = 'toast is-success';
    } else {
      feedback.textContent = apiWarning
        ? `Added ${batchRecords.length} card(s): ${doneCount} extracted, ${failCount} need review. AI unavailable: ${apiWarning}`
        : `Added ${batchRecords.length} card(s): ${doneCount} extracted, ${failCount} need review. ${totalCount} total.`;
      feedback.className = 'toast is-info';
    }
  } catch (error) {
    console.error('Batch processing error:', error);
    feedback.textContent = 'OCR failed. Try again or enter details in the table manually.';
    feedback.className = 'toast is-error';
  } finally {
    isProcessingBatch = false;
    extractionStatus.classList.add('hidden');
    cardInput.value = '';
    updateRefreshButtonState();
  }
}

function loadImageElement(imageData) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageData;
  });
}

async function createOrientationPreview(imageData) {
  const img = await loadImageElement(imageData);
  const scale = Math.min(1, ORIENTATION_PREVIEW_MAX_WIDTH / Math.max(img.width, 1));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function normalizeOrientationDegrees(degrees) {
  const normalized = ((Number(degrees) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function rotateImageDataUrl(imageData, degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) {
    return Promise.resolve(imageData);
  }

  return loadImageElement(imageData).then((img) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (normalized === 90) {
      canvas.width = img.height;
      canvas.height = img.width;
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (normalized === 180) {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
    } else if (normalized === 270) {
      canvas.width = img.height;
      canvas.height = img.width;
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    }

    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.92);
  });
}

function mapOcrLines(result) {
  return (result.data.lines || [])
    .map((line) => ({
      text: line.text.trim(),
      x0: line.bbox.x0,
      x1: line.bbox.x1,
      y0: line.bbox.y0,
      y1: line.bbox.y1,
      height: line.bbox.y1 - line.bbox.y0,
      confidence: line.confidence ?? 0,
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.y0 - b.y0);
}

async function detectOrientation(worker, imageData) {
  const osdPsm = getOcrPsm('OSD_ONLY', '0');
  try {
    await worker.setParameters({ tessedit_pageseg_mode: osdPsm });
    const { data } = await worker.detect(imageData);
    return {
      degrees: normalizeOrientationDegrees(data?.orientation_degrees),
      confidence: data?.orientation_confidence ?? 0,
    };
  } catch {
    return { degrees: 0, confidence: 0 };
  } finally {
    await configureOcrWorker(worker);
  }
}

async function tryDirectOrientationCorrection(worker, imageData) {
  const preview = await createOrientationPreview(imageData);
  const osd = await detectOrientation(worker, preview);

  if (osd.degrees === 0 || osd.confidence < OCR_ORIENTATION_MIN_CONFIDENCE) {
    return null;
  }

  const rotated = await rotateImageDataUrl(imageData, osd.degrees);
  const verifyPreview = await createOrientationPreview(rotated);
  const verify = await detectOrientation(worker, verifyPreview);

  if (verify.degrees === 0 || verify.confidence >= osd.confidence * 0.75) {
    return { image: rotated, rotation: osd.degrees };
  }

  return null;
}

async function resolveUprightImage(worker, imageData) {
  const direct = await tryDirectOrientationCorrection(worker, imageData);
  if (direct) {
    return direct;
  }

  const preview = await createOrientationPreview(imageData);
  const candidates = [0, 90, 180, 270];
  let best = { rotation: 0, score: -1 };

  for (const rotation of candidates) {
    const candidate = rotation === 0
      ? preview
      : await rotateImageDataUrl(preview, rotation);
    const detected = await detectOrientation(worker, candidate);
    const score = detected.degrees === 0
      ? detected.confidence
      : detected.confidence * 0.25;
    if (score > best.score) {
      best = { rotation, score };
    }
  }

  if (best.rotation === 0) {
    return { image: imageData, rotation: 0 };
  }

  return {
    image: await rotateImageDataUrl(imageData, best.rotation),
    rotation: best.rotation,
  };
}


const PHONE_CANDIDATE_REGEX = /(?:\+|00)?(?:\d[\s().-]*){7,16}(?:\s*(?:ext|x)\s*\d{1,6})?/gi;
const POSTAL_CODE_REGEX = /\b(?:[A-Z]\d[A-Z][ -]?\d[A-Z]\d|\d{4,6}(?:-\d{3,4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const MOBILE_LABEL_REGEX = /(^|[^a-z])(mobile|mob|m|cell|cellphone|cellular|whatsapp|wa)(?:\s*[:.\-]|\s+)(?=[+\d(])/i;
const TEL_LABEL_REGEX = /(^|[^a-z])(tel|telephone|phone|ph|direct|office|t)(?:\s*[:.\-]|\s+)(?=[+\d(])/i;
const FAX_LABEL_REGEX = /(^|[^a-z])(fax|facsimile|f)(?:\s*[:.\-]|\s+)(?=[+\d(])/i;
const WEB_REGEX = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|co|org|net|io|ai|biz|sg|in|uk|us|au|ca|de|fr|jp|cn|my|ae|nz)\b)/i;
const COMPANY_SUFFIX_REGEX = /\b(?:inc|llc|ltd|limited|corp|corporation|co\.?|company|group|holdings|partners|studio|studios|agency|solutions|systems|technologies|technology|consulting|associates|enterprises|pte|plc|gmbh|sarl|llp|pvt)\b/i;
const ADDRESS_KEYWORDS = [
  'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'rd', 'drive', 'dr',
  'suite', 'ste', 'floor', 'fl', 'unit', 'apt', 'apartment', 'lane', 'way', 'circle',
  'court', 'ct', 'ln', 'place', 'pl', 'plaza', 'park', 'highway', 'hwy', 'building',
  'bldg', 'tower', 'block', 'blk', 'level', 'lot', 'jalan', 'jln', 'singapore',
  'india', 'usa', 'united states', 'uk', 'australia', 'canada',
];
const POSITION_KEYWORDS = [
  'ceo', 'cto', 'cfo', 'coo', 'president', 'manager', 'director', 'lead', 'engineer',
  'developer', 'designer', 'officer', 'founder', 'co-founder', 'partner', 'consultant',
  'analyst', 'specialist', 'head', 'vp', 'vice president', 'coordinator', 'associate',
  'architect', 'executive', 'principal', 'owner', 'sales', 'marketing', 'account',
  'operations', 'administrator', 'representative', 'advisor', 'producer',
];

function cleanOcrLine(line) {
  return String(line || '')
    .replace(/[|•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmailText(text) {
  let s = String(text || '');

  s = s.replace(/\uFF20/g, '@');
  s = s.replace(/&#0*64;/gi, '@');
  s = s.replace(/\(\s*a\s*\)/gi, '@');
  s = s.replace(/\[\s*at\s*\]/gi, '@');
  s = s.replace(/\{\s*at\s*\}/gi, '@');
  s = s.replace(/(^|[^\w])at\s*[:]\s*/gi, '$1');
  s = s.replace(/e[-\s]?mail\s*[:]\s*/gi, '');
  s = s.replace(/([a-z0-9._%+-])\s+at\s+([a-z0-9])/gi, '$1@$2');
  s = s.replace(/\s*\[dot\]\s*|\s*\(dot\)\s*|\s+dot\s+/gi, '.');
  s = s.replace(/\s*@\s*/g, '@');
  s = s.replace(/\s*\.\s*/g, '.');

  return s;
}

function isValidEmailCandidate(email) {
  const at = email.indexOf('@');
  if (at <= 0 || at >= email.length - 1) {
    return false;
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (!/^[a-z0-9._%+-]+$/i.test(local) || !domain.length || !/^[a-z0-9.-]+$/i.test(domain)) {
    return false;
  }

  if (domain.includes('..') || local.endsWith('.') || domain.startsWith('.')) {
    return false;
  }

  return domain.includes('.') || domain.length >= 3;
}

function sliceEmailAt(text, atIndex) {
  const localChars = /[a-z0-9._%+-]/i;
  const domainChars = /[a-z0-9.-]/i;

  let start = atIndex;
  while (start > 0 && localChars.test(text[start - 1])) {
    start -= 1;
  }

  let end = atIndex + 1;
  while (end < text.length && domainChars.test(text[end])) {
    end += 1;
  }

  let email = text.slice(start, end).replace(/[.,;:]+$/g, '');
  email = email.replace(/^e[-\s]?mail\s*:\s*/i, '');

  return isValidEmailCandidate(email) ? email : '';
}

/** Identify emails by finding @, then expanding to local-part and domain. */
function extractEmail(text) {
  const normalized = normalizeEmailText(text);
  if (!normalized.includes('@')) {
    return '';
  }

  let best = '';
  let searchFrom = 0;

  while (searchFrom < normalized.length) {
    const atIndex = normalized.indexOf('@', searchFrom);
    if (atIndex === -1) {
      break;
    }

    const candidate = sliceEmailAt(normalized, atIndex);
    if (candidate && candidate.length > best.length) {
      best = candidate;
    }
    searchFrom = atIndex + 1;
  }

  return best.toLowerCase();
}

function extractEmailFromOcr(ocrPayload) {
  const chunks = [
    ocrPayload?.text,
    ...(ocrPayload?.lines || []).map((line) => line?.text).filter(Boolean),
    (ocrPayload?.lines || []).map((line) => line?.text).filter(Boolean).join(' '),
  ].filter(Boolean);

  let best = '';
  chunks.forEach((chunk) => {
    const found = extractEmail(chunk);
    if (found && found.length > best.length) {
      best = found;
    }
  });

  return best;
}

function normalizePhoneCandidate(value) {
  return String(value || '')
    .replace(/[^\d+x().\-\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countDigits(value) {
  return (String(value || '').match(/\d/g) || []).length;
}

function companyFromEmail(email) {
  if (!email) return '';
  const domain = email.split('@')[1];
  if (!domain) return '';
  const parts = domain.toLowerCase().split('.');
  const skip = new Set(['www', 'mail', 'email', 'smtp', 'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol', 'proton', 'live']);
  const segment = parts.find((part) => part.length > 1 && !skip.has(part));
  if (!segment) return '';
  return segment
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function looksLikeCompanyLine(line, name, position) {
  line = cleanOcrLine(line);
  if (!line || line === name || line === position) {
    return false;
  }
  if (isContactLine(line) || isAddressLine(line)) {
    return false;
  }
  if (looksLikeName(line)) {
    return false;
  }
  if (POSITION_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(line))) {
    return false;
  }
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10 || line.length < 2) {
    return false;
  }
  return COMPANY_SUFFIX_REGEX.test(line)
    || /[A-Z]{2,}/.test(line)
    || words.some((word) => /^[A-Z][a-zA-Z&.-]{2,}$/.test(word));
}

function findCompanyAboveAddress(lines, address, name, position) {
  const addressStartIndex = address ? lines.findIndex((line) => address.includes(line)) : -1;
  if (addressStartIndex <= 0) {
    return '';
  }

  for (let i = addressStartIndex - 1; i >= 0; i -= 1) {
    const candidate = lines[i];
    if (!looksLikeCompanyLine(candidate, name, position)) {
      continue;
    }
    return candidate;
  }
  return '';
}

function findCompanyFromLogoArea(lineMeta, lines, name, position) {
  const candidates = [];

  if (lineMeta.length > 0) {
    const maxY = Math.max(...lineMeta.map((line) => line.y1), 0);
    const logoThreshold = maxY * 0.42;

    lineMeta
      .filter((line) => line.y1 <= logoThreshold)
      .forEach((line) => {
        if (looksLikeCompanyLine(line.text, name, position)) {
          candidates.push({
            text: line.text,
            score: line.height * 3 + (logoThreshold - line.y0),
          });
        }
      });
  }

  if (candidates.length === 0 && lines.length > 0) {
    const topLineCount = Math.max(2, Math.ceil(lines.length * 0.35));
    lines.slice(0, topLineCount).forEach((lineText, index) => {
      if (looksLikeCompanyLine(lineText, name, position)) {
        candidates.push({
          text: lineText,
          score: (topLineCount - index) * 2,
        });
      }
    });
  }

  if (candidates.length === 0) {
    return '';
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].text;
}

function resolveCompanyName(lines, lineMeta, address, name, position, email) {
  const aboveAddress = findCompanyAboveAddress(lines, address, name, position);
  if (aboveAddress) {
    return aboveAddress;
  }

  const fromEmail = companyFromEmail(email);
  if (fromEmail) {
    return fromEmail;
  }

  return findCompanyFromLogoArea(lineMeta, lines, name, position);
}

function isContactLine(line) {
  line = cleanOcrLine(line);
  if (FAX_LABEL_REGEX.test(line)) {
    return true;
  }
  if (line.includes('@') || extractEmail(line) || WEB_REGEX.test(line)) {
    return true;
  }
  return (line.match(PHONE_CANDIDATE_REGEX) || []).some((candidate) => countDigits(candidate) >= 7);
}

function isAddressLine(line) {
  line = cleanOcrLine(line);
  if (POSTAL_CODE_REGEX.test(line)) return true;
  if (/^(?:#\d+|unit\s+\w+|level\s+\w+)/i.test(line)) return true;
  return ADDRESS_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(line));
}

function looksLikeName(line) {
  line = cleanOcrLine(line);
  if (!line || isContactLine(line) || isAddressLine(line)) return false;
  if (COMPANY_SUFFIX_REGEX.test(line) || POSITION_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(line))) {
    return false;
  }
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  if (words.length === 1) {
    return /^[A-Z][a-z'.-]{2,}$/.test(words[0]) || /^[A-Z]{2,}$/.test(words[0]);
  }
  return words.every((word) => /^[A-Z][a-z'.-]+$/.test(word) || /^[A-Z]{2,}$/.test(word));
}

function isPositionLine(line) {
  return POSITION_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(cleanOcrLine(line)));
}

function findLineIndexInText(lines, value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) {
    return -1;
  }
  return lines.findIndex((line) => {
    const normalized = cleanOcrLine(line).toLowerCase();
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  });
}

/** Name is always above position on vertical cards; fix swapped fields or OCR order mistakes. */
function fixNamePositionOrder(card, sourceText = '') {
  let name = String(card?.name || '').trim();
  let position = String(card?.position || '').trim();
  if (!name && !position) {
    return card;
  }

  if (name && position && isPositionLine(name) && looksLikeName(position)) {
    const correctedName = position;
    position = name;
    name = correctedName;
  }

  const raw = String(sourceText || '').trim();
  if (raw && name && position) {
    const lines = raw.split('\n').map(cleanOcrLine).filter(Boolean);
    const nameIdx = findLineIndexInText(lines, name);
    const posIdx = findLineIndexInText(lines, position);
    if (nameIdx !== -1 && posIdx !== -1 && nameIdx > posIdx) {
      for (let i = posIdx - 1; i >= 0; i -= 1) {
        const candidate = lines[i];
        if (looksLikeName(candidate) && !isPositionLine(candidate)) {
          name = candidate;
          position = lines[posIdx];
          break;
        }
      }
    }
  }

  return { ...card, name, position };
}

function scoreNameLine(line, positionLine) {
  let score = 0;
  if (looksLikeName(line.text)) {
    score += 100;
  } else if (
    !isContactLine(line.text)
    && !isAddressLine(line.text)
    && !looksLikeCompanyLine(line.text, '', positionLine?.text || '')
    && !isPositionLine(line.text)
  ) {
    score += 25;
  } else {
    return 0;
  }

  const gap = positionLine.y0 - line.y1;
  const lineHeight = Math.max(positionLine.height || 12, line.height || 12, 1);
  if (gap >= -lineHeight * 0.35 && gap <= lineHeight * 4) {
    score += 50 - Math.min(Math.abs(gap), lineHeight * 4);
  }

  const cardWidth = Math.max(positionLine.x1, line.x1, 1);
  const rightBias = line.x0 / cardWidth;
  score += rightBias * 20;

  score += (line.height || 0) * 2;
  score += (line.confidence || 0) / 10;
  return score;
}

/**
 * Name is always directly above position on vertical cards; on split layouts it may be on the right.
 */
function findNameFromPosition(lineMeta, lines, position) {
  if (!position?.trim()) {
    return '';
  }

  const positionLine = lineMeta.find((line) => line.text === position)
    || lineMeta.find((line) => normalizeKey(line.text) === normalizeKey(position));

  if (positionLine) {
    const lineHeight = Math.max(positionLine.height || 12, 12);
    const scored = lineMeta
      .filter((line) => {
        if (!line.text || line.text === positionLine.text) {
          return false;
        }
        const gap = positionLine.y0 - line.y1;
        return gap >= -lineHeight * 0.35;
      })
      .map((line) => ({ text: line.text, score: scoreNameLine(line, positionLine) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return scored[0].text;
    }
  }

  const positionIndex = lines.indexOf(position);
  if (positionIndex > 0) {
    for (let i = positionIndex - 1; i >= 0; i -= 1) {
      const candidate = lines[i];
      if (isContactLine(candidate) || isAddressLine(candidate)) {
        continue;
      }
      if (looksLikeCompanyLine(candidate, '', position) || isPositionLine(candidate)) {
        continue;
      }
      return candidate;
    }
  }

  return '';
}

function extractPhonesFromLines(lines) {
  const candidates = [];

  lines.forEach((rawLine, lineIndex) => {
    const line = cleanOcrLine(rawLine);
    if (FAX_LABEL_REGEX.test(line)) return;

    const labeledPatterns = [
      { regex: MOBILE_LABEL_REGEX, labelScore: 80 },
      { regex: TEL_LABEL_REGEX, labelScore: 35 },
    ];

    let lineLabelScore = 0;
    for (const { regex, labelScore } of labeledPatterns) {
      const match = line.match(regex);
      if (match) {
        lineLabelScore = Math.max(lineLabelScore, labelScore);
      }
    }

    (line.match(PHONE_CANDIDATE_REGEX) || []).forEach((match) => {
      const phone = normalizePhoneCandidate(match);
      const digitCount = countDigits(phone);
      if (digitCount < 7 || digitCount > 16) return;
      if (POSTAL_CODE_REGEX.test(phone) && digitCount < 8) return;

      candidates.push({
        phone,
        key: phone.replace(/\D/g, ''),
        score: lineLabelScore + (phone.trim().startsWith('+') ? 12 : 0) + Math.min(digitCount, 12) - lineIndex,
      });
    });
  });

  const unique = new Map();
  candidates.forEach((candidate) => {
    const current = unique.get(candidate.key);
    if (!current || candidate.score > current.score) {
      unique.set(candidate.key, candidate);
    }
  });

  return [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate) => candidate.phone)
    .join(' / ');
}

function parseExtractedText(ocrResult) {
  const text = typeof ocrResult === 'string' ? ocrResult : ocrResult?.text || '';
  const layoutLines = typeof ocrResult === 'object' ? ocrResult?.lines || [] : [];

  if (!text.trim()) {
    return { name: '', position: '', company: '', address: '', phone: '', email: '' };
  }

  const lines = text.split('\n').map(cleanOcrLine).filter((l) => l.length > 0);

  const lineMeta = layoutLines.length > 0
    ? layoutLines.map((line) => ({ ...line, text: cleanOcrLine(line.text) })).filter((line) => line.text)
    : lines.map((lineText, index) => ({ text: lineText, y0: index, y1: index + 1, height: 1 }));

  const email = extractEmailFromOcr({
    text,
    lines: lineMeta.map((line) => ({ text: line.text })),
  }) || extractEmail(text);
  const phone = extractPhonesFromLines(lines);
  const postalCode = (text.match(POSTAL_CODE_REGEX) || [])[0] || '';

  const maxY = Math.max(...lineMeta.map((line) => line.y1), 0);
  const bottomThreshold = maxY * 0.55;
  const topThreshold = maxY * 0.45;

  const bottomLines = lineMeta.filter((line) => line.y0 >= bottomThreshold).map((line) => line.text);
  const topLines = lineMeta.filter((line) => line.y1 <= topThreshold || line.y0 <= topThreshold);

  let address = '';
  const addressParts = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isContactLine(line) || (email && normalizeEmailText(line).includes(email))) continue;
    if (isAddressLine(line) || (bottomLines.includes(line) && (/^\d+/.test(line) || line.includes(',')))) {
      addressParts.unshift(line);
      for (let j = i - 1; j >= 0 && addressParts.length < 4; j -= 1) {
        const previousLine = lines[j];
        if (isContactLine(previousLine) || looksLikeName(previousLine)) break;
        if (
          isAddressLine(previousLine)
          || /^\d+[\w\s,./#-]+/.test(previousLine)
          || /[,#-]/.test(previousLine)
        ) {
          addressParts.unshift(previousLine);
          continue;
        }
        break;
      }
      break;
    }
  }
  if (addressParts.length > 0) {
    address = addressParts.join(', ');
    if (postalCode && !address.includes(postalCode)) {
      address = `${address} ${postalCode}`;
    }
  }

  let position = '';
  const positionCandidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !isContactLine(line) && !isAddressLine(line))
    .filter(({ line }) => isPositionLine(line));
  if (positionCandidates.length > 0) {
    position = positionCandidates[0].line;
  }

  let name = '';
  if (position) {
    name = findNameFromPosition(lineMeta, lines, position);
  }

  if (!name) {
    const sortedTopLines = [...topLines].sort((a, b) => {
      const confidenceDelta = (b.confidence || 0) - (a.confidence || 0);
      return (b.height - a.height) || confidenceDelta;
    });
    const prominentTopLine = sortedTopLines.find((line) => looksLikeName(line.text))
      || sortedTopLines.find((line) => (
        !isContactLine(line.text)
        && !isAddressLine(line.text)
        && !looksLikeCompanyLine(line.text, '', position)
        && !isPositionLine(line.text)
      ));
    if (prominentTopLine) {
      name = prominentTopLine.text;
    }
  }

  if (!name) {
    const nameCandidateIndex = lines.findIndex((line) => looksLikeName(line));
    if (nameCandidateIndex !== -1) {
      name = lines[nameCandidateIndex];
    }
  }

  if (!position && name) {
    const nameIndex = lines.indexOf(name);
    const lineBelowName = nameIndex !== -1 ? lines[nameIndex + 1] : '';
    if (lineBelowName && !isContactLine(lineBelowName) && !isAddressLine(lineBelowName)) {
      position = lineBelowName;
    }
  }

  const company = resolveCompanyName(lines, lineMeta, address, name, position, email);

  return fixNamePositionOrder({
    name: name.trim(),
    position: position.trim(),
    company: company.trim(),
    address: address.trim(),
    phone: phone.trim(),
    email: email.trim(),
  }, text);
}

fileDrop.addEventListener('dragenter', (e) => {
  e.preventDefault();
});

fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('drag-over');
});

fileDrop.addEventListener('dragleave', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
});

fileDrop.addEventListener('drop', async (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');

  if (e.dataTransfer.files.length > 0) {
    await processFiles(e.dataTransfer.files);
  }
});

cardInput.addEventListener('change', async () => {
  if (!cardInput.files || cardInput.files.length === 0) {
    return;
  }
  await processFiles(cardInput.files);
});

if (exportToSheetsButton) {
  exportToSheetsButton.addEventListener('click', saveToGoogleSheet);
}
if (signOutButton) {
  signOutButton.addEventListener('click', handleSignOut);
}
if (spreadsheetIdInput) {
  spreadsheetIdInput.addEventListener('input', updateSheetControls);
}
if (copyButton) {
  copyButton.addEventListener('click', copyToClipboard);
}
if (refreshCardButton) {
  refreshCardButton.addEventListener('click', reanalyzeActiveCard);
}
updateRefreshButtonState();
