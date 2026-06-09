const { parsePhoneNumberFromString } = require('libphonenumber-js');

const SHEET_FIELDS = ['name', 'position', 'company', 'address', 'phone', 'email'];

function countDigits(value) {
  return (String(value || '').match(/\d/g) || []).length;
}

function splitPhoneParts(value) {
  return String(value ?? '')
    .trim()
    .split(/\s*\/\s*|[\n;,|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatPhoneList(value, separator = ' / ') {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'NA') {
    return raw === 'NA' ? 'NA' : '';
  }

  const parts = splitPhoneParts(raw);
  if (!parts.length) {
    return '';
  }

  return parts.map(formatSinglePhoneForSheet).filter(Boolean).join(separator);
}

function mergePhoneValues(primary, fallback) {
  const primaryTrimmed = String(primary ?? '').trim();
  const fallbackTrimmed = String(fallback ?? '').trim();

  if (!primaryTrimmed) {
    return fallbackTrimmed;
  }
  if (!fallbackTrimmed) {
    return primaryTrimmed;
  }

  const seen = new Set();
  const merged = [];

  for (const part of [...splitPhoneParts(primaryTrimmed), ...splitPhoneParts(fallbackTrimmed)]) {
    const key = part.replace(/\D/g, '');
    if (key.length >= 7 && !seen.has(key)) {
      seen.add(key);
      merged.push(part);
    }
  }

  return merged.join(' / ');
}

function formatSinglePhoneForSheet(phone) {
  const trimmed = String(phone || '')
    .trim()
    .replace(/^(?:mobile|mob|m|tel|telephone|phone|ph|cell|whatsapp|wa|direct|office)\s*[:.\-]?\s*/i, '');
  if (!trimmed) {
    return '';
  }

  const extMatch = trimmed.match(/\s*(?:ext|x|extension)\s*\.?\s*(\d{1,6})\s*$/i);
  const extension = extMatch ? extMatch[1] : '';
  const mainPart = extMatch ? trimmed.slice(0, extMatch.index).trim() : trimmed;
  const digits = mainPart.replace(/\D/g, '');

  if (digits.length < 7) {
    return trimmed;
  }

  const parsed = parsePhoneNumberFromString(mainPart);
  if (parsed?.isValid()) {
    const formatted = parsed.formatInternational();
    return extension ? `${formatted} ext ${extension}` : formatted;
  }

  const hasPlus = /^\s*\+/.test(mainPart);

  let formatted = '';

  if (hasPlus || digits.length > 10) {
    if (digits.length === 11 && digits[0] === '1') {
      formatted = `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
    } else if (digits.length === 10 && digits.startsWith('65')) {
      formatted = `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
    } else if (digits.length === 11 && digits.startsWith('44')) {
      formatted = `+44 ${digits.slice(2, 6)} ${digits.slice(6)}`;
    } else if (digits.length >= 10) {
      const ccLen = digits.length >= 12 ? 2 : (digits[0] === '1' ? 1 : 2);
      const cc = digits.slice(0, ccLen);
      const rest = digits.slice(ccLen);
      const groups = rest.match(/.{1,4}/g) || [];
      formatted = `+${cc} ${groups.join(' ')}`.trim();
    } else {
      formatted = `+${digits}`;
    }
  } else if (digits.length === 10) {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else {
    formatted = mainPart.replace(/[^\d+().\-\s]/gi, '').replace(/\s+/g, ' ').trim();
  }

  return extension ? `${formatted} ext ${extension}` : formatted;
}

/**
 * Normalize phone text for Google Sheets (readable, no formula characters).
 */
function formatPhoneForSheet(value) {
  return formatPhoneList(value, ' / ');
}

/** One-line phone text for clipboard paste (no newlines inside the cell). */
function formatPhoneForClipboard(value) {
  return formatPhoneList(value, ' / ');
}

function flattenToSingleLine(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHEETS_FORMULA_PREFIX = /^[=+\-@#]/;

/**
 * Format one field for tab-separated clipboard paste into Google Sheets.
 * Keeps each contact on a single row and avoids #ERROR! from +, =, @, etc.
 */
function escapeSpreadsheetPasteCell(value, field) {
  let text = sanitizeSheetCell(value);

  if (field === 'phone') {
    text = formatPhoneForClipboard(text);
  } else {
    text = flattenToSingleLine(text);
  }

  if (!text || text === 'NA') {
    return text === 'NA' ? 'NA' : '';
  }

  const mustQuote = field === 'phone'
    || field === 'email'
    || SHEETS_FORMULA_PREFIX.test(text)
    || /[\t\r\n"]/.test(text);

  if (mustQuote) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function rowsToClipboardTsv(rows) {
  return rows.map((row) => row.join('\t')).join('\n');
}

function sanitizeSheetCell(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function sanitizeCardForSheet(card) {
  const source = card && typeof card === 'object' ? card : {};
  const sanitized = {};

  SHEET_FIELDS.forEach((field) => {
    let text = sanitizeSheetCell(source[field]);
    if (field === 'phone') {
      text = formatPhoneForSheet(text);
    }
    sanitized[field] = text;
  });

  return sanitized;
}

const formatSheetValue = {
  SHEET_FIELDS,
  splitPhoneParts,
  mergePhoneValues,
  formatPhoneList,
  formatPhoneForSheet,
  formatPhoneForClipboard,
  formatSinglePhoneForSheet,
  flattenToSingleLine,
  escapeSpreadsheetPasteCell,
  rowsToClipboardTsv,
  sanitizeSheetCell,
  sanitizeCardForSheet,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = formatSheetValue;
}

if (typeof window !== 'undefined') {
  window.CardFlowSheetFormat = formatSheetValue;
}
