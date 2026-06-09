const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBusinessCard,
  validateCardForExport,
  validateBusinessCardWithOptionalAi,
  normalizePhone,
  normalizeWebsite,
} = require('../lib/validation');

test('validates and normalizes a complete business card', () => {
  const result = validateBusinessCard({
    name: '  Priya Sharma  ',
    jobTitle: 'Managing Director',
    company: 'Northstar Media',
    email: 'priya.sharma@northstar-media.co.uk',
    phone: 'M +44 20 7946 0958',
    website: 'www.northstar-media.co.uk',
    address: '45 King Street, London EC2V 8AB',
  }, { defaultCountry: 'GB' });

  assert.equal(result.valid, true);
  assert.equal(result.requiresReview, false);
  assert.equal(result.normalizedData.name, 'Priya Sharma');
  assert.equal(result.normalizedData.phone, '+44 20 7946 0958');
  assert.equal(result.normalizedData.website, 'https://www.northstar-media.co.uk');
  assert.ok(result.confidence >= 90);
  assert.equal(result.originalData.name, '  Priya Sharma  ');
});

test('rejects missing required fields and placeholder values', () => {
  const result = validateBusinessCard({
    name: 'N/A',
    company: '-',
    email: 'unknown',
    phone: '+1 512 555 8844',
  });

  assert.equal(result.valid, false);
  assert.ok(result.confidence < 85);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    [
      'PLACEHOLDER_VALUE',
      'PLACEHOLDER_VALUE',
      'PLACEHOLDER_VALUE',
      'MISSING_REQUIRED_FIELD',
      'MISSING_REQUIRED_FIELD',
      'MISSING_REQUIRED_FIELD',
    ],
  );
});

test('flags invalid email addresses', () => {
  const result = validateBusinessCard({
    name: 'Alex Kim',
    company: 'Acme Labs',
    email: 'alex@acme',
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'INVALID_EMAIL'));
});

test('normalizes valid phone numbers with libphonenumber-js', () => {
  const phone = normalizePhone('(512) 555-8844', 'US');

  assert.equal(phone.valid, true);
  assert.equal(phone.value, '+1 512 555 8844');
});

test('flags phone numbers that cannot be parsed', () => {
  const result = validateBusinessCard({
    name: 'Alex Kim',
    company: 'Acme Labs',
    email: 'alex@acmelabs.com',
    phone: '123',
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'INVALID_PHONE'));
});

test('normalizes websites and rejects invalid domains', () => {
  const valid = normalizeWebsite('acmelabs.com/contact');
  const invalid = normalizeWebsite('not a domain');

  assert.equal(valid.valid, true);
  assert.equal(valid.value, 'https://acmelabs.com/contact');
  assert.equal(invalid.valid, false);
});

test('warns about likely OCR email domain mistakes', () => {
  const result = validateBusinessCard({
    name: 'Jo Rao',
    company: 'Independent',
    email: 'jo@gmaiI.com',
  });

  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'POSSIBLE_OCR_EMAIL_DOMAIN'));
});

test('warns when email and website domains do not resemble each other', () => {
  const result = validateBusinessCard({
    name: 'Alex Kim',
    company: 'Acme Labs',
    email: 'alex@different-example.com',
    website: 'https://acmelabs.com',
  });

  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'EMAIL_WEBSITE_DOMAIN_MISMATCH'));
});

test('supports the existing app position field as a jobTitle alias', () => {
  const result = validateBusinessCard({
    name: 'Priya Sharma',
    position: 'Managing Director',
    company: 'Northstar Media',
    email: 'priya@northstar-media.co.uk',
  });

  assert.equal(result.normalizedData.jobTitle, 'Managing Director');
});

test('validates multiple phone numbers joined with slash separators', () => {
  const result = validateBusinessCard({
    name: 'Costas Delaportas',
    company: 'Northstar Media',
    email: 'costas@northstar-media.co.uk',
    phone: '+44 20 7946 0958 / +44 20 7946 0959',
  }, { defaultCountry: 'GB' });

  assert.equal(result.valid, true);
  assert.equal(result.normalizedData.phone, '+44 20 7946 0958 / +44 20 7946 0959');
  assert.equal(result.issues.some((issue) => issue.code === 'INVALID_PHONE'), false);
});

test('export validation ignores phone numbers and only checks required fields', () => {
  const result = validateCardForExport({
    name: 'Dionysis Kourouklis',
    company: 'Acme',
    email: 'dionysis@acme.com',
    phone: '+30 694 2443003 / +30 216 6004902',
  });

  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test('export validation still requires name, company, and email', () => {
  const result = validateCardForExport({
    name: 'Dionysis Kourouklis',
    company: '',
    email: 'not-an-email',
    phone: '+30 694 2443003 / +30 216 6004902',
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'MISSING_REQUIRED_FIELD'));
  assert.ok(result.issues.some((issue) => issue.code === 'INVALID_EMAIL'));
  assert.equal(result.issues.some((issue) => issue.field === 'phone'), false);
});

test('allows export when phone cannot be parsed but required fields are present', () => {
  const result = validateBusinessCard({
    name: 'Alex Kim',
    company: 'Acme Labs',
    email: 'alex@acmelabs.com',
    phone: '98765 43210',
  }, { forExport: true });

  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'INVALID_PHONE'));
});

test('still blocks export when required fields are missing', () => {
  const result = validateBusinessCard({
    name: 'Alex Kim',
    company: '',
    email: 'alex@acmelabs.com',
    phone: '123',
  }, { forExport: true });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'MISSING_REQUIRED_FIELD'));
  assert.ok(result.warnings.some((warning) => warning.code === 'INVALID_PHONE'));
});

test('runs optional AI validation only below the confidence threshold', async () => {
  let callCount = 0;
  const openai = {
    chat: {
      completions: {
        create: async () => {
          callCount += 1;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: 'Likely OCR mistake.',
                  issues: ['Email domain is malformed.'],
                  suggestedCorrections: { email: 'alex@gmail.com' },
                }),
              },
            }],
          };
        },
      },
    },
  };

  const clean = await validateBusinessCardWithOptionalAi({
    name: 'Alex Kim',
    company: 'Acme Labs',
    email: 'alex@acmelabs.com',
    website: 'https://acmelabs.com',
  }, { openai });

  assert.equal(clean.aiValidation, null);
  assert.equal(callCount, 0);

  const suspicious = await validateBusinessCardWithOptionalAi({
    name: 'A',
    company: '-',
    email: 'alex@bad',
  }, { openai });

  assert.equal(callCount, 1);
  assert.equal(suspicious.aiValidation.suggestedCorrections.email, 'alex@gmail.com');
});
