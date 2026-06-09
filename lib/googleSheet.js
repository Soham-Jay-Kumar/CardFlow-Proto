const { google } = require('googleapis');
const { normalizeSpreadsheetId } = require('./loadServiceAccount');
const { sanitizeCardForSheet } = require('./formatSheetValue');

const SHEET_COLUMNS = ['name', 'position', 'company', 'address', 'phone', 'email'];
const HEADER_ROW = ['Name', 'Position', 'Company', 'Address', 'Phone', 'Email'];

async function ensureHeaderRow(sheets, sheetId) {
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'A1:F1',
  });

  const firstRow = existing.data.values?.[0] || [];
  const hasHeaders = firstRow.length >= 3;
  if (hasHeaders) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'A1:F1',
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_ROW] },
  });
}

function cardToRowValues(cardData) {
  return SHEET_COLUMNS.map((field) => String(cardData?.[field] ?? '').trim());
}

/**
 * Append one contact row to a spreadsheet using the user's OAuth2 client.
 */
async function saveToUserSheet(auth, cardData, spreadsheetId) {
  const sheetId = normalizeSpreadsheetId(spreadsheetId);
  if (!sheetId) {
    throw new Error(
      'No spreadsheet ID. Paste your Google Sheet URL in the app (the ID is between /d/ and /edit in the URL).',
    );
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const sanitized = sanitizeCardForSheet(cardData);

  await ensureHeaderRow(sheets, sheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'A:F',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [cardToRowValues(sanitized)],
    },
  });

  return sheetId;
}

module.exports = {
  SHEET_COLUMNS,
  saveToUserSheet,
};
