/**
 * Identify emails by locating @ (or OCR variants like " at "), then expanding
 * local-part and domain.
 */

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

  if (!/^[a-z0-9._%+-]+$/i.test(local)) {
    return false;
  }

  if (!domain.length || !/^[a-z0-9.-]+$/i.test(domain)) {
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

function extractEmailByAt(text) {
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

/**
 * Scan full text and individual lines (OCR often breaks emails across lines).
 */
function extractEmailFromSources(...sources) {
  const chunks = [];

  sources.forEach((source) => {
    if (!source) {
      return;
    }
    if (typeof source === 'string') {
      chunks.push(source);
      return;
    }
    if (source.text) {
      chunks.push(source.text);
    }
    if (Array.isArray(source.lines)) {
      source.lines.forEach((line) => {
        const lineText = typeof line === 'string' ? line : line?.text;
        if (lineText) {
          chunks.push(lineText);
        }
      });
      chunks.push(
        source.lines
          .map((line) => (typeof line === 'string' ? line : line?.text || ''))
          .filter(Boolean)
          .join(' '),
      );
    }
  });

  let best = '';
  chunks.forEach((chunk) => {
    const found = extractEmailByAt(chunk);
    if (found && found.length > best.length) {
      best = found;
    }
  });

  return best;
}

module.exports = {
  normalizeEmailText,
  extractEmailByAt,
  extractEmailFromSources,
};
