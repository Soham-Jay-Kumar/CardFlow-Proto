const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, 'lib', '.env') });

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');
const OpenAI = require('openai');
const sharp = require('sharp');
const {
  decodeBase64Image,
  preprocessImageForVision,
} = require('./lib/preprocessImage');
const { extractEmailByAt, extractEmailFromSources } = require('./lib/extractEmail');
const { saveToUserSheet } = require('./lib/googleSheet');
const { normalizeSpreadsheetId } = require('./lib/loadServiceAccount');
const {
  validateBusinessCard,
  validateCardForExport,
  runAiValidation,
} = require('./lib/validation');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const EXTRACT_MODEL = 'gpt-4o-mini';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function getOAuthCallbackUrl(req) {
  const fromEnv = process.env.GOOGLE_CALLBACK_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }
  if (req?.get?.('host')) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${proto}://${req.get('host')}`;
  }
  return `http://127.0.0.1:${PORT}`;
}

function getJavascriptOrigin(req) {
  return getOAuthCallbackUrl(req);
}

function getLocalOAuthUriOptions() {
  return [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
}

function isGoogleOAuthCallback(req) {
  return typeof req.query?.code === 'string' && req.query.code.length > 0;
}

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(
  session({
    secret: SESSION_SECRET || 'cardflow-dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

function isOAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && SESSION_SECRET);
}

function createOAuthClientFromSession(user, req) {
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    getOAuthCallbackUrl(req),
  );
  client.setCredentials({
    access_token: user?.accessToken,
    refresh_token: user?.refreshToken,
  });
  return client;
}

if (isOAuthConfigured()) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: getOAuthCallbackUrl(),
      },
      (accessToken, refreshToken, profile, done) => {
        done(null, {
          accessToken,
          refreshToken,
          id: profile.id,
          displayName: profile.displayName,
          email: profile.emails?.[0]?.value || '',
        });
      },
    ),
  );
}

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

function requireAuth(req, res, next) {
  if (req.isAuthenticated?.() && req.user?.accessToken) {
    return next();
  }
  return res.status(401).json({
    error: 'Sign in with Google to export contacts to your spreadsheet.',
    code: 'NOT_AUTHENTICATED',
  });
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    position: { type: 'string' },
    company: { type: 'string' },
    address: { type: 'string' },
    phone: { type: 'string' },
    email: { type: 'string' },
    website: { type: 'string' },
    raw_notes: { type: 'string' },
  },
  required: [
    'name',
    'position',
    'company',
    'address',
    'phone',
    'email',
    'website',
    'raw_notes',
  ],
  additionalProperties: false,
};

const EMPTY_CARD = Object.fromEntries(
  CARD_SCHEMA.required.map((field) => [field, '']),
);

const JOB_TITLE_PATTERN = /\b(ceo|cto|cfo|coo|vp|vice president|president|manager|director|lead|engineer|developer|founder|co-founder|partner|consultant|analyst|specialist|head|chief|officer|architect|executive|principal|owner|associate|coordinator|representative|administrator|advisor|producer)\b/i;

const SYSTEM_PROMPT = [
  'You extract structured business card data. The JSON schema is strict: every field is required.',
  'Use an empty string for missing or unclear values—never omit keys and never use null.',
  'Layout rule (critical): On standard vertical cards the person name is ALWAYS printed directly',
  'ABOVE the job title/position. Never put the title in name or the person name in position. If',
  'OCR line order disagrees with the image, trust the image: name above, title below. Exception:',
  'split layouts may place the name to the right of the title block—still never swap name/title.',
  'Name: Extract only person names (no slogans, departments, or company names). Use the line',
  'immediately above the position, or to the immediate right on split cards. If unclear, infer',
  'from the email local-part in First Last title case (e.g. jane.smith@company.com -> Jane Smith).',
  'Position: Extract job titles only (Manager, Director, Engineer, Founder, etc.). Always the line',
  'directly below the person name on vertical cards. If multiple titles exist, prioritize the',
  'most senior (VP over Director over Manager). Ignore departments (e.g. Sales Dept)—raw_notes.',
  'If name and title share one line separated by | or comma, split them (e.g. "Alex Kim | Director"',
  '-> name Alex Kim, position Director).',
  'Company: Identify from the logo area or the line directly above the address. If missing,',
  'fallback to the work email domain (skip gmail.com, yahoo.com, etc.).',
  'Address: Combine multi-line physical address strings; strip websites and emails; preserve',
  'postal codes.',
  'Contacts: Identify email addresses by finding the @ symbol, then read the local-part and domain',
  'around it (fix OCR spacing like "jane . doe @ corp . com" -> jane.doe@corp.com).',
  'Phone: Include every non-fax number on the card (mobile, office, direct, tel, etc.). When there',
  'are multiple numbers, join them with " / " (e.g. "+1 512 555 8844 / +1 512 555 9999"). Prioritize',
  'mobile/mob/m/WhatsApp labels first, then office/direct/tel. Ignore Fax. Put websites in website.',
  'raw_notes: slogans, departments, secondary titles, and other leftover text.',
].join(' ');

/** Few-shot 1: name on the right of the card, beside the title block */
const FEW_SHOT_NAME_RIGHT_INPUT = [
  'TECHFLOW SOLUTIONS',
  'Engineering Division',
  '                    Michael Torres',
  '                    Lead Architect',
  '12 Innovation Way',
  'Austin TX 78701',
  'WhatsApp +1 512 555 8844',
  'm.torres@techflow-solutions.com',
  'www.techflow-solutions.com',
].join('\n');

const FEW_SHOT_NAME_RIGHT_OUTPUT = {
  name: 'Michael Torres',
  position: 'Lead Architect',
  company: 'Techflow Solutions',
  address: '12 Innovation Way, Austin TX 78701',
  phone: '+1 512 555 8844',
  email: 'm.torres@techflow-solutions.com',
  website: 'https://www.techflow-solutions.com',
  raw_notes: 'Department: Engineering Division.',
};

/** Few-shot 2: person name not printed clearly—infer from email local-part */
const FEW_SHOT_NAME_EMAIL_INPUT = [
  'GLOBAL PARTNERS LLC',
  'Sales Department',
  'VP Business Development',
  '88 Harbour Road',
  'Hong Kong',
  'M +852 6789 0123',
  'Fax +852 6789 0999',
  'a . chen @ globalpartners . com',
].join('\n');

const FEW_SHOT_NAME_EMAIL_OUTPUT = {
  name: 'Aaron Chen',
  position: 'VP Business Development',
  company: 'Global Partners LLC',
  address: '88 Harbour Road, Hong Kong',
  phone: '+852 6789 0123',
  email: 'a.chen@globalpartners.com',
  website: '',
  raw_notes: 'Department: Sales Department. Ignored fax +852 6789 0999. Name inferred from email.',
};

/** Few-shot 3: standard vertical stack — name line always above position line */
const FEW_SHOT_NAME_ABOVE_INPUT = [
  'NORTHSTAR MEDIA',
  'Priya Sharma',
  'Managing Director',
  '45 King Street',
  'London EC2V 8AB',
  'M +44 20 7946 0958',
  'priya.sharma@northstar-media.co.uk',
].join('\n');

const FEW_SHOT_NAME_ABOVE_OUTPUT = {
  name: 'Priya Sharma',
  position: 'Managing Director',
  company: 'Northstar Media',
  address: '45 King Street, London EC2V 8AB',
  phone: '+44 20 7946 0958',
  email: 'priya.sharma@northstar-media.co.uk',
  website: '',
  raw_notes: '',
};

const FEW_SHOT_MESSAGES = [
  {
    role: 'user',
    content: `Business card OCR (name directly above position):\n${FEW_SHOT_NAME_ABOVE_INPUT}`,
  },
  { role: 'assistant', content: JSON.stringify(FEW_SHOT_NAME_ABOVE_OUTPUT) },
  {
    role: 'user',
    content: `Business card OCR (name-on-the-right layout):\n${FEW_SHOT_NAME_RIGHT_INPUT}`,
  },
  { role: 'assistant', content: JSON.stringify(FEW_SHOT_NAME_RIGHT_OUTPUT) },
  {
    role: 'user',
    content: `Business card OCR (name inferred from email):\n${FEW_SHOT_NAME_EMAIL_INPUT}`,
  },
  { role: 'assistant', content: JSON.stringify(FEW_SHOT_NAME_EMAIL_OUTPUT) },
];

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud',
  'aol', 'proton', 'protonmail', 'mail', 'email', 'smtp', 'www',
]);

function toTitleCaseWord(word) {
  if (!word) {
    return '';
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function formatFirstLast(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => toTitleCaseWord(part.replace(/[^a-zA-Z'.-]/g, '')))
    .filter(Boolean)
    .join(' ');
}

function looksLikeJobTitle(text) {
  return JOB_TITLE_PATTERN.test(String(text || '').trim());
}

function looksLikePersonName(text) {
  const line = String(text || '').trim();
  if (!line || looksLikeJobTitle(line)) {
    return false;
  }
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) {
    return false;
  }
  return words.every(
    (word) => /^[A-Z][a-z'.-]+$/.test(word) || /^[A-Z]{2,}$/.test(word) || /^[A-Z]\.$/.test(word),
  );
}

function findLineIndex(lines, value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) {
    return -1;
  }
  return lines.findIndex((line) => {
    const normalized = line.trim().toLowerCase();
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  });
}

/** Correct swapped name/position using layout: name is always above title on vertical cards. */
function fixNamePositionOrder(card, sourceText = '') {
  let name = String(card?.name || '').trim();
  let position = String(card?.position || '').trim();
  if (!name && !position) {
    return card;
  }

  if (name && position && looksLikeJobTitle(name) && looksLikePersonName(position)) {
    const correctedName = formatFirstLast(position);
    position = name;
    name = correctedName;
  }

  const raw = String(sourceText || '').trim();
  if (raw && name && position) {
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const nameIdx = findLineIndex(lines, name);
    const posIdx = findLineIndex(lines, position);
    if (nameIdx !== -1 && posIdx !== -1 && nameIdx > posIdx) {
      for (let i = posIdx - 1; i >= 0; i -= 1) {
        const candidate = lines[i];
        if (looksLikePersonName(candidate) && !looksLikeJobTitle(candidate)) {
          name = formatFirstLast(candidate);
          position = lines[posIdx];
          break;
        }
      }
    }
  }

  return { ...card, name, position };
}

function nameFromEmail(email) {
  const local = String(email || '').trim().toLowerCase().split('@')[0];
  if (!local) {
    return '';
  }

  const cleaned = local.replace(/\d+$/g, '');
  const parts = cleaned
    .split(/[._-]+/)
    .map((part) => part.replace(/[^a-z]/g, ''))
    .filter((part) => part.length >= 2);

  if (parts.length === 0) {
    const single = cleaned.replace(/[^a-z]/g, '');
    return single.length >= 2 ? toTitleCaseWord(single) : '';
  }

  return parts.map(toTitleCaseWord).join(' ');
}

function companyFromEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const domain = normalized.split('@')[1];
  if (!domain) {
    return '';
  }

  const parts = domain.split('.').filter(Boolean);
  const segment = parts.find((part) => part.length > 1 && !GENERIC_EMAIL_DOMAINS.has(part));
  if (!segment) {
    return '';
  }

  return segment
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeExtractedCard(parsed, sourceText = '') {
  const result = { ...EMPTY_CARD };
  for (const field of CARD_SCHEMA.required) {
    const value = parsed?.[field];
    result[field] = typeof value === 'string' ? value.trim() : '';
  }

  const emailFromSources = extractEmailFromSources(
    sourceText,
    sourceText ? { lines: sourceText.split(/\n/).map((line) => ({ text: line })) } : null,
    result.email,
  );
  result.email = emailFromSources || extractEmailByAt(result.email) || '';

  if (!result.name && result.email) {
    const inferredName = nameFromEmail(result.email);
    if (inferredName) {
      result.name = inferredName;
    }
  } else if (result.name) {
    result.name = formatFirstLast(result.name);
  }

  if (!result.company && result.email) {
    const inferred = companyFromEmail(result.email);
    if (inferred) {
      result.company = inferred;
    }
  }

  return fixNamePositionOrder(result, sourceText);
}

/**
 * Resolve base64Image from body (primary) with legacy aliases.
 */
function getBase64ImageFromBody(body) {
  const raw =
    body?.base64Image
    ?? body?.image
    ?? body?.imageBase64;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * AI path step 1: decode base64, then Sharp grayscale + contrast boost before vision.
 */
async function prepareVisionImage(base64Image, mimeTypeOverride) {
  const { buffer, mimeType } = decodeBase64Image(base64Image);
  if (!buffer.length) {
    throw Object.assign(new Error('Decoded image is empty'), { code: 'INVALID_IMAGE' });
  }

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw Object.assign(
      new Error('Could not read image dimensions; upload a valid JPEG or PNG business card photo'),
      { code: 'INVALID_IMAGE' },
    );
  }

  let processed;
  try {
    processed = await preprocessImageForVision(buffer);
  } catch (err) {
    throw Object.assign(
      new Error(`Image preprocessing failed: ${err.message}`),
      { code: 'PREPROCESS_FAILED', cause: err },
    );
  }

  return {
    dataUrl: processed.dataUrl,
    mimeType: mimeTypeOverride || mimeType,
    width: metadata.width,
    height: metadata.height,
    preprocessed: true,
  };
}

function buildAiPathMessages(finalUserMessage) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...FEW_SHOT_MESSAGES,
    finalUserMessage,
  ];
}

function buildVisionUserMessage(imageDataUrl, ocrText) {
  const textParts = [
    'Apply the AI path rules to this Sharp-preprocessed grayscale business card image.',
    'Use layout, font weight, logos, and spacing. The person name is always above the job title',
    '(or to the immediate right on split layouts)—never swap them.',
  ];
  if (ocrText?.trim()) {
    textParts.push(
      `Optional OCR hint (prefer the image when they conflict):\n${ocrText.trim()}`,
    );
  }

  return {
    role: 'user',
    content: [
      { type: 'text', text: textParts.join('\n\n') },
      {
        type: 'image_url',
        image_url: { url: imageDataUrl, detail: 'high' },
      },
    ],
  };
}

function buildTextUserMessage(text) {
  return {
    role: 'user',
    content: [
      'Apply the AI path rules to this OCR text:',
      text.trim(),
    ].join('\n\n'),
  };
}

async function runAiExtraction(messages, mode, sourceText = '') {
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: EXTRACT_MODEL,
      temperature: 0,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'business_card',
          strict: true,
          schema: CARD_SCHEMA,
        },
      },
    });
  } catch (err) {
    throw mapOpenAiError(err, mode);
  }

  return parseModelResponse(completion, mode, sourceText);
}

/** AI path: Sharp preprocess -> vision model with few-shot examples -> normalize */
async function runVisionExtraction(imageDataUrl, ocrText) {
  const messages = buildAiPathMessages(buildVisionUserMessage(imageDataUrl, ocrText));
  return runAiExtraction(messages, 'vision', ocrText);
}

async function runTextExtraction(text) {
  const messages = buildAiPathMessages(buildTextUserMessage(text));
  return runAiExtraction(messages, 'text', text);
}

function toValidationInput(card) {
  return {
    name: card?.name || '',
    jobTitle: card?.jobTitle || card?.position || '',
    company: card?.company || '',
    email: card?.email || '',
    phone: card?.phone || '',
    website: card?.website || '',
    address: card?.address || '',
  };
}

async function validateExtractionForReview(card) {
  const validationInput = toValidationInput(card);
  const validation = validateBusinessCard(validationInput);
  const aiValidation = await runAiValidation(validationInput, {
    openai,
    validationResult: validation,
    model: EXTRACT_MODEL,
  });

  return { validation, aiValidation };
}

function parseModelResponse(completion, mode, sourceText = '') {
  const finishReason = completion.choices[0]?.finish_reason;
  const content = completion.choices[0]?.message?.content;

  if (finishReason === 'content_filter') {
    throw Object.assign(
      new Error('Vision model refused to process this image (content filter)'),
      { code: 'VISION_BLOCKED', statusCode: 422 },
    );
  }

  if (!content) {
    throw Object.assign(
      new Error(
        mode === 'vision'
          ? 'Vision model returned an empty response; the image may be unreadable or too low resolution'
          : 'Model returned an empty response',
      ),
      { code: 'EMPTY_MODEL_RESPONSE', statusCode: 502 },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw Object.assign(
      new Error(
        mode === 'vision'
          ? 'Vision model returned invalid JSON; try a clearer, well-lit card photo'
          : 'Model returned invalid JSON',
      ),
      { code: 'JSON_PARSE_FAILED', statusCode: 502, cause: err },
    );
  }

  return normalizeExtractedCard(parsed, sourceText);
}

function mapOpenAiError(err, mode) {
  const status = err.status ?? err.statusCode;
  const apiMessage = err.error?.message || err.message || 'Unknown OpenAI error';

  if (status === 401) {
    return Object.assign(new Error('Invalid OpenAI API key'), { statusCode: 502 });
  }
  if (status === 429) {
    return Object.assign(new Error('OpenAI rate limit exceeded; retry in a moment'), {
      statusCode: 429,
    });
  }
  if (status === 400 && /image/i.test(apiMessage)) {
    return Object.assign(
      new Error(
        `Vision model could not read the image: ${apiMessage}. Use a JPEG or PNG under 15MB.`,
      ),
      { code: 'VISION_IMAGE_REJECTED', statusCode: 422 },
    );
  }
  if (status === 400) {
    return Object.assign(
      new Error(`OpenAI rejected the request: ${apiMessage}`),
      { statusCode: 400 },
    );
  }

  return Object.assign(
    new Error(
      mode === 'vision'
        ? `Vision extraction failed: ${apiMessage}`
        : `Extraction failed: ${apiMessage}`,
    ),
    { statusCode: status && status >= 400 && status < 600 ? status : 500 },
  );
}

function respondWithExtractError(res, err) {
  const statusCode = err.statusCode ?? 500;
  const payload = {
    error: err.message || 'Failed to extract contact details',
  };
  if (err.code) {
    payload.code = err.code;
  }
  return res.status(statusCode).json(payload);
}

function googleAuthOptions(req) {
  return {
    scope: ['openid', 'email', 'profile', SPREADSHEETS_SCOPE],
    accessType: 'offline',
    prompt: 'consent',
    callbackURL: getOAuthCallbackUrl(req),
  };
}

app.get('/auth/google', (req, res, next) => {
  if (!isOAuthConfigured()) {
    return res.status(503).send('Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and SESSION_SECRET in .env.');
  }
  return passport.authenticate('google', googleAuthOptions(req))(req, res, next);
});

function completeGoogleOAuth(req, res, next) {
  if (!isOAuthConfigured()) {
    return res.redirect('/?auth=error');
  }
  return passport.authenticate('google', {
    ...googleAuthOptions(req),
    failureRedirect: '/?auth=failed',
    session: true,
  })(req, res, next);
}

app.get('/auth/google/callback', (req, res, next) => {
  completeGoogleOAuth(req, res, (err) => {
    if (err) {
      console.error('Google OAuth callback error:', err);
      const reason = encodeURIComponent(err.name || 'oauth_error');
      return res.redirect(`/?auth=failed&reason=${reason}`);
    }
    res.redirect('/?auth=success');
  });
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

app.get('/api/auth/status', (req, res) => {
  const authenticated = Boolean(req.isAuthenticated?.() && req.user?.accessToken);
  res.json({
    authenticated,
    oauthConfigured: isOAuthConfigured(),
    email: authenticated ? req.user.email || '' : '',
    displayName: authenticated ? req.user.displayName || '' : '',
  });
});

app.post('/extract', async (req, res) => {
  const body = req.body ?? {};
  const base64Image = getBase64ImageFromBody(body);
  const text = typeof body.text === 'string' ? body.text : '';
  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.startsWith('image/')
      ? body.mimeType
      : undefined;

  if (!base64Image && !text.trim()) {
    return res.status(400).json({
      error: 'Body must include a non-empty "base64Image" string (and optional "text" OCR hint)',
      code: 'MISSING_INPUT',
    });
  }

  if (!openai) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY is not configured',
      code: 'MISSING_API_KEY',
    });
  }

  try {
    let result;
    if (base64Image) {
      // AI path: decode -> Sharp (grayscale + contrast) -> gpt-4o-mini vision
      const image = await prepareVisionImage(base64Image, mimeType);
      result = await runVisionExtraction(image.dataUrl, text);
    } else {
      result = await runTextExtraction(text);
    }

    const { validation, aiValidation } = await validateExtractionForReview(result);

    return res.json({
      ...result,
      validation,
      aiValidation,
    });
  } catch (err) {
    console.error('POST /extract:', err);

    if (err.code === 'INVALID_IMAGE') {
      return respondWithExtractError(
        res,
        Object.assign(err, { statusCode: 400 }),
      );
    }
    if (err.code === 'PREPROCESS_FAILED') {
      return respondWithExtractError(
        res,
        Object.assign(err, {
          statusCode: 422,
          message:
            'Could not preprocess the card image. Ensure base64Image is a valid JPEG or PNG.',
        }),
      );
    }

    return respondWithExtractError(res, err);
  }
});

const publicDir = path.join(__dirname);

app.get('/', (req, res, next) => {
  if (req.query.error) {
    const reason = encodeURIComponent(String(req.query.error));
    const description = req.query.error_description
      ? `&description=${encodeURIComponent(String(req.query.error_description))}`
      : '';
    return res.redirect(`/?auth=failed&reason=${reason}${description}`);
  }
  if (isGoogleOAuthCallback(req)) {
    return completeGoogleOAuth(req, res, (err) => {
      if (err) {
        console.error('Google OAuth callback error:', err);
        const reason = encodeURIComponent(err.name || 'oauth_error');
        return res.redirect(`/?auth=failed&reason=${reason}`);
      }
      res.redirect('/?auth=success');
    });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/api/google-config', (req, res) => {
  res.json({
    oauthConfigured: isOAuthConfigured(),
    redirectUri: getOAuthCallbackUrl(req),
    javascriptOrigin: getJavascriptOrigin(req),
    redirectUriOptions: getLocalOAuthUriOptions(),
    javascriptOriginOptions: getLocalOAuthUriOptions(),
    setup: {
      clientType: 'Web application',
      redirectField: 'Authorized redirect URIs',
      originField: 'Authorized JavaScript origins',
      uriFormat: 'No path — use http://127.0.0.1:3000 or http://localhost:3000 only',
      consentScreen: 'Testing (required for localhost / 127.0.0.1)',
    },
    methods: {
      clipboard: true,
      oauthExport: isOAuthConfigured(),
    },
  });
});

app.post('/api/export-to-sheet', requireAuth, async (req, res) => {
  const body = req.body ?? {};
  const spreadsheetId = typeof body.spreadsheetId === 'string' ? body.spreadsheetId.trim() : '';
  const cards = Array.isArray(body.cards) ? body.cards : [];

  if (!cards.length) {
    return res.status(400).json({ error: 'Body must include a non-empty "cards" array' });
  }

  const sheetId = normalizeSpreadsheetId(spreadsheetId);
  if (!sheetId) {
    return res.status(400).json({
      error: 'Paste your Google Spreadsheet URL or ID before exporting.',
      code: 'MISSING_SPREADSHEET_ID',
    });
  }

  const auth = createOAuthClientFromSession(req.user, req);

  try {
    const validationResults = cards.map((card, index) => ({
      index,
      validation: validateCardForExport(toValidationInput(card)),
    }));
    const invalidCards = validationResults.filter((result) => !result.validation.valid);

    if (invalidCards.length) {
      return res.status(422).json({
        error: 'One or more contacts failed validation. Review the issues before exporting.',
        code: 'VALIDATION_FAILED',
        invalidCards,
      });
    }

    for (const card of cards) {
      await saveToUserSheet(auth, card, sheetId);
    }
    return res.json({
      ok: true,
      rowsWritten: cards.length,
      spreadsheetId: sheetId,
      validationResults,
    });
  } catch (err) {
    console.error('POST /api/export-to-sheet:', err);
    return res.status(500).json({
      error: err.message || 'Failed to write to Google Sheet',
      code: 'SHEETS_APPEND_FAILED',
    });
  }
});

app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('client.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body', code: 'INVALID_JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body too large (max 15MB)',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  next(err);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  if (err.code === 'EPERM') {
    console.error(`Cannot bind to ${HOST}:${PORT}. Try HOST=127.0.0.1 PORT=3001 npm start.`);
    process.exitCode = 1;
    return;
  }
  throw err;
});
