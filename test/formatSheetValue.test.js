const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatPhoneForSheet,
  formatPhoneForClipboard,
  mergePhoneValues,
} = require('../lib/formatSheetValue');

test('exports multiple phones joined with slash separators', () => {
  const input = 'M +1 512 555 8844 / Tel +1 512 555 9999 / Direct +1 512 555 1234';
  const formatted = formatPhoneForSheet(input);

  assert.match(formatted, /\+1 512 555 8844/);
  assert.match(formatted, /\+1 512 555 9999/);
  assert.match(formatted, /\+1 512 555 1234/);
  assert.equal(formatted.split(' / ').length, 3);
  assert.equal(formatted, formatPhoneForClipboard(input));
});

test('preserves Greek international phone formatting for sheets', () => {
  const input = '+30 694 2443003 / +30 216 6004902';
  const formatted = formatPhoneForSheet(input);

  assert.match(formatted, /\+30 694 244 3003/);
  assert.match(formatted, /\+30 21 6600 4902/);
  assert.equal(formatted.split(' / ').length, 2);
});

test('mergePhoneValues combines AI and local phone lists without duplicates', () => {
  const merged = mergePhoneValues(
    '+1 512 555 8844',
    'M +1 512 555 8844 / Tel +1 512 555 9999',
  );

  assert.equal(merged, '+1 512 555 8844 / Tel +1 512 555 9999');
});
