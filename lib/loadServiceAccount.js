const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

const PLACEHOLDER_SHEET_IDS = new Set([
  'YOUR_SHEET_ID_HERE',
  'your-spreadsheet-id-from-url',
  'your-spreadsheet-id',
]);

function pickString(source, keys) {
  if (!source || typeof source !== 'object') {
    return '';
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizePrivateKey(key) {
  return String(key || '').replace(/\\n/g, '\n').trim();
}

function parseServiceAccountJson(raw, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceLabel} is not valid JSON`);
  }

  const clientEmail = pickString(parsed, ['client_email', 'clientEmail']);
  const privateKey = normalizePrivateKey(
    pickString(parsed, ['private_key', 'privateKey']),
  );

  if (!clientEmail || !privateKey) {
    throw new Error(`${sourceLabel} must include client_email and private_key`);
  }

  return { client_email: clientEmail, private_key: privateKey };
}

function loadFromEnvVars() {
  const clientEmail = pickString(process.env, [
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  ]);
  const privateKey = normalizePrivateKey(
    pickString(process.env, ['GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY']),
  );

  if (!clientEmail || !privateKey) {
    return null;
  }

  return { client_email: clientEmail, private_key: privateKey, source: 'environment' };
}

function getCredentialFileCandidates() {
  const fromEnv = pickString(process.env, [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_SERVICE_ACCOUNT_FILE',
    'GOOGLE_CREDENTIALS_PATH',
  ]);

  const candidates = [];
  if (fromEnv) {
    candidates.push(path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT_DIR, fromEnv));
  }

  candidates.push(
    path.join(ROOT_DIR, 'credentials.json'),
    path.join(ROOT_DIR, 'service-account.json'),
    path.join(ROOT_DIR, 'google-credentials.json'),
    path.join(__dirname, 'credentials.json'),
  );

  return [...new Set(candidates)];
}

function loadServiceAccountCredentials() {
  const fromEnv = loadFromEnvVars();
  if (fromEnv) {
    return fromEnv;
  }

  for (const filePath of getCredentialFileCandidates()) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const credentials = parseServiceAccountJson(raw, path.basename(filePath));
    return { ...credentials, source: filePath };
  }

  return null;
}

function hasServiceAccountCredentials() {
  return Boolean(loadServiceAccountCredentials());
}

function getServiceAccountEmail() {
  return loadServiceAccountCredentials()?.client_email || '';
}

function normalizeSpreadsheetId(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (raw.includes('docs.google.com/spreadsheets/d/')) {
    const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match?.[1] && !PLACEHOLDER_SHEET_IDS.has(match[1]) ? match[1] : '';
  }

  if (PLACEHOLDER_SHEET_IDS.has(raw)) {
    return '';
  }

  return raw;
}

function getDefaultSpreadsheetId() {
  return normalizeSpreadsheetId(
    pickString(process.env, ['GOOGLE_SPREADSHEET_ID', 'SPREADSHEET_ID']),
  );
}

module.exports = {
  PLACEHOLDER_SHEET_IDS,
  loadServiceAccountCredentials,
  hasServiceAccountCredentials,
  getServiceAccountEmail,
  normalizeSpreadsheetId,
  getDefaultSpreadsheetId,
  getCredentialFileCandidates,
};
