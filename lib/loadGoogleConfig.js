const path = require('path');
const fs = require('fs');
const {
  hasServiceAccountCredentials,
  getServiceAccountEmail,
  getDefaultSpreadsheetId,
  getCredentialFileCandidates,
} = require('./loadServiceAccount');

const ROOT_DIR = path.join(__dirname, '..');
const LIB_DIR = __dirname;

const API_KEY_PATTERN = /AIza[A-Za-z0-9_-]{20,}/;
const CLIENT_ID_PATTERN = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/i;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      return;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

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

function parseFromObject(obj) {
  return {
    apiKey: pickString(obj, [
      'googleApiKey',
      'apiKey',
      'API_KEY',
      'api_key',
      'google_api_key',
    ]),
    clientId: pickString(obj, [
      'googleClientId',
      'clientId',
      'CLIENT_ID',
      'client_id',
      'oauthClientId',
    ]),
  };
}

function parseFromText(text) {
  let apiKey = '';
  let clientId = '';

  if (!text?.trim()) {
    return { apiKey, clientId };
  }

  const apiMatch = text.match(API_KEY_PATTERN);
  if (apiMatch) {
    apiKey = apiMatch[0];
  }

  const clientMatch = text.match(CLIENT_ID_PATTERN);
  if (clientMatch) {
    clientId = clientMatch[0];
  }

  try {
    const fromJson = parseFromObject(JSON.parse(text));
    apiKey = apiKey || fromJson.apiKey;
    clientId = clientId || fromJson.clientId;
  } catch {
    // not JSON
  }

  const quotedApi = text.match(/(?:googleApiKey|apiKey|API_KEY)\s*[:=]\s*['"]([^'"]+)['"]/i);
  if (quotedApi) {
    apiKey = apiKey || quotedApi[1].trim();
  }

  const quotedClient = text.match(
    /(?:googleClientId|clientId|CLIENT_ID)\s*[:=]\s*['"]([^'"]+)['"]/i,
  );
  if (quotedClient) {
    clientId = clientId || quotedClient[1].trim();
  }

  return { apiKey, clientId };
}

function loadGoogleBrowserConfig() {
  loadEnvFile(path.join(ROOT_DIR, '.env'));
  loadEnvFile(path.join(LIB_DIR, '.env'));

  let apiKey = pickString(process.env, ['GOOGLE_API_KEY', 'API_KEY']) || '';
  let clientId = pickString(process.env, ['GOOGLE_CLIENT_ID', 'CLIENT_ID']) || '';

  const candidateFiles = [
    path.join(LIB_DIR, 'credentials.JSON.js'),
    path.join(LIB_DIR, 'credentials.json'),
    path.join(ROOT_DIR, 'credentials.json'),
  ];

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    if (filePath.endsWith('.js')) {
      try {
        delete require.cache[require.resolve(filePath)];
        const fromModule = parseFromObject(require(filePath));
        apiKey = apiKey || fromModule.apiKey;
        clientId = clientId || fromModule.clientId;
      } catch {
        // fall through
      }
    }

    const fromText = parseFromText(fs.readFileSync(filePath, 'utf8'));
    apiKey = apiKey || fromText.apiKey;
    clientId = clientId || fromText.clientId;

    if (apiKey && clientId) {
      break;
    }
  }

  return {
    apiKey,
    clientId,
    configured: Boolean(apiKey && clientId),
  };
}

function getGoogleSetupStatus() {
  const browser = loadGoogleBrowserConfig();
  const hasServiceAccount = hasServiceAccountCredentials();
  const defaultSpreadsheetId = getDefaultSpreadsheetId();
  const credentialCandidates = getCredentialFileCandidates();
  const credentialsFileFound = credentialCandidates.some((filePath) => fs.existsSync(filePath));

  return {
    browser,
    serviceAccount: {
      credentialsFileFound,
      spreadsheetIdSet: Boolean(defaultSpreadsheetId),
      defaultSpreadsheetId,
      serviceAccountEmail: getServiceAccountEmail(),
      ready: hasServiceAccount,
    },
    envFilesChecked: [
      fs.existsSync(path.join(ROOT_DIR, '.env')) ? '.env' : null,
      fs.existsSync(path.join(LIB_DIR, '.env')) ? 'lib/.env' : null,
      fs.existsSync(path.join(LIB_DIR, 'credentials.JSON.js')) ? 'lib/credentials.JSON.js' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  loadGoogleBrowserConfig,
  getGoogleSetupStatus,
};
