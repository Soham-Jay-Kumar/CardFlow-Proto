const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { splitPhoneParts } = require('./formatSheetValue');

const BUSINESS_CARD_FIELDS = [
  'name',
  'jobTitle',
  'company',
  'email',
  'phone',
  'website',
  'address',
];

const REQUIRED_FIELDS = ['name', 'company', 'email'];
const PLACEHOLDER_VALUES = new Set([
  '',
  '-',
  '--',
  '---',
  'n/a',
  'na',
  'none',
  'null',
  'unknown',
  'not available',
  'not applicable',
  'undefined',
]);

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

const EMAIL_REGEX = /^[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']{2,}$/i;
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const OCR_ARTIFACT_REGEX = /[|]{2,}|_{2,}|~{2,}|�|(?:^|\s)[•*]{2,}(?:\s|$)/;
const GOOGLE_CONFUSABLE_DOMAIN_REGEX = /\bgma[i1l][i1l]\.com\b/i;

function createEmptyCard() {
  return Object.fromEntries(BUSINESS_CARD_FIELDS.map((field) => [field, '']));
}

function normalizeInputShape(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const normalized = createEmptyCard();

  for (const field of BUSINESS_CARD_FIELDS) {
    normalized[field] = source[field] == null ? '' : String(source[field]);
  }

  // The existing app uses "position"; the requested agent contract uses "jobTitle".
  if (!normalized.jobTitle && source.position != null) {
    normalized.jobTitle = String(source.position);
  }

  return normalized;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.|]+|[\s:;,.|]+$/g, '')
    .trim();
}

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(cleanText(value).toLowerCase());
}

function addFinding(collection, field, code, message, deduction = 0, suggestion = '') {
  collection.push({ field, code, message, deduction, suggestion });
}

function extractDomainFromEmail(email) {
  const parts = cleanText(email).toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : '';
}

function normalizeWebsite(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw || isPlaceholder(raw)) {
    return { value: '', valid: false, domain: '' };
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (!DOMAIN_REGEX.test(domain)) {
      return { value: cleanText(value), valid: false, domain };
    }
    parsed.hash = '';
    return {
      value: parsed.toString().replace(/\/$/, ''),
      valid: true,
      domain,
    };
  } catch {
    return { value: cleanText(value), valid: false, domain: '' };
  }
}

function normalizePhone(value, defaultCountry = 'US') {
  const cleaned = cleanText(value)
    .replace(/^(?:mobile|mob|m|cell|phone|tel|telephone|whatsapp|wa)\s*[:.\-]?\s*/i, '')
    .replace(/[^\d+().\-\s extx]/gi, '')
    .trim();

  if (!cleaned || isPlaceholder(cleaned)) {
    return { value: '', valid: false, country: '', type: '' };
  }

  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    return { value: cleaned, valid: false, country: parsed?.country || '', type: '' };
  }

  return {
    value: parsed.formatInternational(),
    valid: true,
    country: parsed.country || '',
    type: parsed.getType?.() || '',
  };
}

function normalizePhones(value, defaultCountry = 'US') {
  const parts = splitPhoneParts(value);
  if (!parts.length) {
    return { value: '', valid: false };
  }

  const results = parts.map((part) => normalizePhone(part, defaultCountry));
  const allValid = results.every((result) => result.valid);

  if (allValid) {
    return {
      value: results.map((result) => result.value).join(' / '),
      valid: true,
    };
  }

  const anyValid = results.some((result) => result.valid);
  if (anyValid) {
    return {
      value: parts.map((part, index) => (
        results[index].valid ? results[index].value : cleanText(part)
      )).join(' / '),
      valid: true,
    };
  }

  return {
    value: cleanText(value),
    valid: false,
  };
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const matrix = Array.from({ length: left.length + 1 }, (_, row) => [row]);

  for (let col = 1; col <= right.length; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let col = 1; col <= right.length; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function domainRoot(domain) {
  const parts = String(domain || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length < 2) {
    return '';
  }
  return parts[parts.length - 2];
}

function normalizeCompanyForComparison(company) {
  return cleanText(company)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|company|co|group|solutions|services)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function domainsResembleCompany(emailDomain, websiteDomain, company) {
  const emailRoot = domainRoot(emailDomain);
  const websiteRoot = domainRoot(websiteDomain);
  const companyRoot = normalizeCompanyForComparison(company);

  if (emailRoot && websiteRoot && (emailRoot === websiteRoot || levenshtein(emailRoot, websiteRoot) <= 2)) {
    return true;
  }

  if (!companyRoot) {
    return false;
  }

  return [emailRoot, websiteRoot].some((root) => (
    root && (companyRoot.includes(root) || root.includes(companyRoot) || levenshtein(root, companyRoot) <= 2)
  ));
}

function buildValidationPrompt(card) {
  return [
    'You are validating extracted business card JSON.',
    'Identify likely extraction mistakes, OCR confusions, and suggested corrections.',
    'Do not invent missing data. Return only JSON matching the requested schema.',
    '',
    JSON.stringify(card, null, 2),
  ].join('\n');
}

function parseAiValidationContent(content) {
  if (!content) {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch {
    return {
      summary: String(content).trim(),
      suggestedCorrections: {},
      issues: ['AI response was not JSON.'],
    };
  }
}

/**
 * Rule-based business card validator.
 *
 * It never mutates the input object. All cleanup is returned in normalizedData,
 * while the original extraction remains available in originalData.
 */
function validateBusinessCard(extractedData, options = {}) {
  const originalData = normalizeInputShape(extractedData);
  const normalizedData = createEmptyCard();
  const issues = [];
  const warnings = [];
  const corrections = [];
  const defaultCountry = options.defaultCountry || 'US';
  let confidence = 100;

  for (const field of BUSINESS_CARD_FIELDS) {
    const raw = originalData[field];
    const cleaned = cleanText(raw);

    if (isPlaceholder(cleaned)) {
      normalizedData[field] = '';
      if (cleaned) {
        addFinding(issues, field, 'PLACEHOLDER_VALUE', `${field} contains a placeholder value.`, 12);
      }
      continue;
    }

    normalizedData[field] = cleaned;
    if (raw !== cleaned) {
      corrections.push({
        field,
        original: raw,
        normalized: cleaned,
        reason: 'Trimmed whitespace and removed obvious OCR/control artifacts.',
      });
    }

    if (OCR_ARTIFACT_REGEX.test(cleaned)) {
      addFinding(warnings, field, 'OCR_ARTIFACT', `${field} contains characters that look like OCR artifacts.`, 5);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!normalizedData[field]) {
      addFinding(issues, field, 'MISSING_REQUIRED_FIELD', `${field} is required but missing.`, 18);
    }
  }

  if (normalizedData.email) {
    if (!EMAIL_REGEX.test(normalizedData.email)) {
      addFinding(issues, 'email', 'INVALID_EMAIL', 'Email address is not valid.', 20);
    } else if (GOOGLE_CONFUSABLE_DOMAIN_REGEX.test(normalizedData.email) && !/gmail\.com$/i.test(normalizedData.email)) {
      addFinding(warnings, 'email', 'POSSIBLE_OCR_EMAIL_DOMAIN', 'Email domain may be an OCR mistake for gmail.com.', 8, 'gmail.com');
    }
  }

  if (normalizedData.phone) {
    const phone = normalizePhones(normalizedData.phone, defaultCountry);
    if (!phone.valid) {
      addFinding(issues, 'phone', 'INVALID_PHONE', 'Phone number could not be parsed.', 15);
    } else {
      if (phone.value !== normalizedData.phone) {
        corrections.push({
          field: 'phone',
          original: normalizedData.phone,
          normalized: phone.value,
          reason: 'Normalized with libphonenumber-js.',
        });
      }
      normalizedData.phone = phone.value;
    }
  }

  let websiteDomain = '';
  if (normalizedData.website) {
    const website = normalizeWebsite(normalizedData.website);
    websiteDomain = website.domain;
    if (!website.valid) {
      addFinding(issues, 'website', 'INVALID_WEBSITE', 'Website does not contain a valid domain.', 15);
    } else {
      if (website.value !== normalizedData.website) {
        corrections.push({
          field: 'website',
          original: normalizedData.website,
          normalized: website.value,
          reason: 'Added protocol and normalized URL formatting.',
        });
      }
      normalizedData.website = website.value;
    }
  }

  if (normalizedData.name && normalizedData.name.replace(/[^a-z]/gi, '').length < 3) {
    addFinding(warnings, 'name', 'SHORT_NAME', 'Name is extremely short and may be incomplete.', 8);
  }

  if (normalizedData.company && normalizedData.company.replace(/[^a-z0-9]/gi, '').length < 3) {
    addFinding(warnings, 'company', 'SHORT_COMPANY', 'Company name is extremely short and may be incomplete.', 8);
  }

  const emailDomain = extractDomainFromEmail(normalizedData.email);
  if (emailDomain && websiteDomain && !GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
    const emailRoot = domainRoot(emailDomain);
    const websiteRoot = domainRoot(websiteDomain);
    const domainsMatch = emailRoot
      && websiteRoot
      && (emailRoot === websiteRoot || levenshtein(emailRoot, websiteRoot) <= 2);

    if (!domainsMatch) {
      addFinding(
        warnings,
        'email',
        'EMAIL_WEBSITE_DOMAIN_MISMATCH',
        'Email domain does not resemble the company website domain.',
        10,
      );
    }
  }

  if (normalizedData.email && normalizedData.website && !issues.some((issue) => issue.field === 'email' || issue.field === 'website')) {
    confidence += 3;
  }
  if (normalizedData.company && domainsResembleCompany(emailDomain, websiteDomain, normalizedData.company)) {
    confidence += 3;
  }
  if (normalizedData.name && normalizedData.jobTitle && normalizedData.company && normalizedData.email && normalizedData.phone) {
    confidence += 4;
  }

  for (const finding of [...issues, ...warnings]) {
    confidence -= finding.deduction || 0;
  }

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  let finalIssues = issues;
  let finalWarnings = warnings;

  // Export only needs name, company, and email. Keep phone/website text as entered even
  // when libphonenumber or URL parsing cannot normalize them.
  if (options.forExport) {
    const relaxedWarnings = [];
    finalIssues = [];

    for (const finding of issues) {
      if (finding.code === 'INVALID_PHONE' || finding.code === 'INVALID_WEBSITE') {
        relaxedWarnings.push(finding);
      } else {
        finalIssues.push(finding);
      }
    }

    finalWarnings = [...warnings, ...relaxedWarnings];
  }

  return {
    valid: finalIssues.length === 0,
    confidence,
    warnings: finalWarnings,
    issues: finalIssues,
    normalizedData,
    originalData,
    corrections,
    requiresReview: confidence < 85 || finalIssues.length > 0,
  };
}

/**
 * Optional AI second opinion. Call only when the rule-based confidence is low.
 * Suggested corrections are returned separately and never applied automatically.
 */
async function runAiValidation(extractedData, options = {}) {
  const {
    openai,
    model = 'gpt-4o-mini',
    confidenceThreshold = 85,
    validationResult = validateBusinessCard(extractedData, options),
  } = options;

  if (validationResult.confidence >= confidenceThreshold) {
    return null;
  }
  if (!openai) {
    return {
      skipped: true,
      reason: 'OpenAI client was not provided.',
      suggestedCorrections: {},
      issues: [],
    };
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'Return JSON only: {"summary":"","issues":[],"suggestedCorrections":{}}. Suggestions must be explicit and must not overwrite the original extraction.',
      },
      { role: 'user', content: buildValidationPrompt(extractedData) },
    ],
    response_format: { type: 'json_object' },
  });

  return parseAiValidationContent(response.choices?.[0]?.message?.content);
}

async function validateBusinessCardWithOptionalAi(extractedData, options = {}) {
  const validation = validateBusinessCard(extractedData, options);
  const aiValidation = await runAiValidation(extractedData, {
    ...options,
    validationResult: validation,
  });

  return {
    ...validation,
    aiValidation,
  };
}

/**
 * Export gate: only name, company, and email must be present and valid.
 * Phone numbers are passed through as entered and formatted when writing to Sheets.
 */
function validateCardForExport(extractedData) {
  const originalData = normalizeInputShape(extractedData);
  const issues = [];

  for (const field of REQUIRED_FIELDS) {
    const cleaned = cleanText(originalData[field]);
    if (!cleaned || isPlaceholder(cleaned)) {
      addFinding(issues, field, 'MISSING_REQUIRED_FIELD', `${field} is required but missing.`, 18);
    }
  }

  const email = cleanText(originalData.email);
  if (email && !isPlaceholder(email) && !EMAIL_REGEX.test(email)) {
    addFinding(issues, 'email', 'INVALID_EMAIL', 'Email address is not valid.', 20);
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings: [],
  };
}

module.exports = {
  BUSINESS_CARD_FIELDS,
  REQUIRED_FIELDS,
  validateBusinessCard,
  validateCardForExport,
  validateBusinessCardWithOptionalAi,
  runAiValidation,
  normalizePhone,
  normalizePhones,
  normalizeWebsite,
};
