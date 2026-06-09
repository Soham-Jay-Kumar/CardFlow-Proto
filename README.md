# CardFlow Proto

A website that automatically extracts business card information from images using OCR, displays it for review, and stores it in a local table.

## Files

- `index.html` — main UI with Tesseract.js OCR library
- `styles.css` — clean design using the specified palette
- `client.js` — browser OCR, image normalization, parser fallback, table management, and Google Sheets UI
- `app.js` — static server and AI extraction endpoint (`POST /extract`) using GPT-4o vision when `OPENAI_API_KEY` is configured
- `lib/validation.js` — reusable Validation Agent for rule-based checks, confidence scoring, normalization, and optional AI second opinion
- `lib/preprocessImage.js` — optional Sharp helper to grayscale and boost contrast before local OCR
- `examples/validation-example.js` — runnable Validation Agent input/output example

## Workflow

1. Upload a business card image
2. The site automatically extracts text using Tesseract.js OCR
3. Extracted information is parsed into: Name, Position, Company, Company Address, Phone number, and Email. If the server has `OPENAI_API_KEY`, the card image is sent to GPT-4o vision (with optional OCR text as context); otherwise the local parser is used.
4. Review the extracted fields (edit if needed)
5. The server validates extracted data, returns confidence/warnings, and triggers AI validation when confidence is below 85
6. Copy the reviewed table or insert the rows into Google Sheets
7. If you edit any extracted fields, your corrections are saved locally for similar cards later

## Validation Agent

`lib/validation.js` accepts extracted card JSON in this shape:

```json
{
  "name": "",
  "jobTitle": "",
  "company": "",
  "email": "",
  "phone": "",
  "website": "",
  "address": ""
}
```

It returns `valid`, `confidence`, `warnings`, `issues`, `normalizedData`, `originalData`, `corrections`, and `requiresReview`. The module never silently overwrites extracted data; cleaned values and suggested corrections are returned separately. The existing app field `position` is accepted as an alias for `jobTitle`.

Run the example:

```bash
node examples/validation-example.js
```

## Google Sheets — Save to Google Sheet

### Option A: Server export (recommended, no sign-in)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a service account and download its JSON key.
2. Save that file as `credentials.json` in the project root (same folder as `app.js`).
3. Open your Google Sheet → **Share** → add the service account email (from the JSON, e.g. `something@project.iam.gserviceaccount.com`) as **Editor**.
4. Paste the spreadsheet URL in the app and click **Save to Google Sheet**.

Optional: set `GOOGLE_SPREADSHEET_ID=...` in `.env` so the ID is pre-filled.

### Option B: Browser sign-in

1. Enable the Google Sheets API and create an OAuth **Web** client ID plus an API key.
2. Add them to `lib/credentials.JSON.js` or root `.env` as `GOOGLE_API_KEY` and `GOOGLE_CLIENT_ID`.
3. Restart `npm start`. Confirm `http://localhost:3000/api/google-config` shows `"configured": true`.
4. Sign in with Google, paste the spreadsheet URL, then click **Save to Google Sheet**.

## Notes

- No user typing required; extraction is fully automatic
- User corrections are persisted locally so the app can learn from mistakes
- Google sign-in and Google Sheets integration are supported when configured with valid API credentials
- The results table is stored locally in the browser
