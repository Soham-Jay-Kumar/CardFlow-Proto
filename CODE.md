# Comprehensive Code Review

Review date: 2026-06-08

Scope reviewed: first-party project files in the repository root, `lib/`, `test/`, `examples/`, package metadata, docs, and local config examples. I excluded third-party `node_modules/` package internals from the review, but noted its presence.

## Summary

CardFlow Pro has the core pieces requested: browser Tesseract OCR, editable extracted fields, local correction persistence, Google OAuth-backed Sheets export, and validation tests. The largest risks are security and deployment boundaries: the Express server serves the project root as static web content while real credential files exist in that root, and CORS/session/export routes are broad enough to create avoidable abuse paths. There are also several requirement mismatches around the configured colour scheme, preview placement, "similar" correction reuse, and stale documentation.

Tests run:

```bash
npm test
```

Result: 12/12 tests passed.

## Findings

### Critical: `credentials.json` is exposed by the static server

`app.js` sets `publicDir` to the project root and serves it through `express.static`:

- `app.js:797`
- `app.js:893`

Because `credentials.json` exists at the root and is not a dotfile, it is web-accessible when the app is running, for example at `/credentials.json`. That file is a Google credential file by convention and should never be publicly served. The same static setup also exposes source files such as `/app.js`, `/client.js`, `/package.json`, examples, tests, and local docs.

Recommended fix: move public assets into a dedicated `public/` directory and serve only that directory. Keep all credentials outside the served tree. Also remove any real `credentials.json` and `.env` from the project folder after rotating exposed credentials.

### High: Cross-origin credentialed CORS is too permissive

`app.js:61` enables `cors({ origin: true, credentials: true })`, reflecting arbitrary origins while allowing credentials. Authenticated routes such as `/api/export-to-sheet` depend on the browser session cookie (`app.js:841`). This combination makes it easier for another origin to interact with the app in a signed-in browser, especially in local or legacy browser contexts.

Recommended fix: restrict CORS to the app origin or remove CORS entirely for same-origin web usage. Add CSRF protection for state-changing authenticated routes.

### High: OAuth setup help has a Host-header reflected HTML injection path

The server derives `redirectUri` from `req.get('host')` (`app.js:40-42`) and returns it from `/api/google-config` (`app.js:820-826`). The client inserts those URI strings directly into `innerHTML` in `renderOAuthSetupHelp` (`client.js:443-458`) without escaping. A malicious or malformed `Host` header can therefore become HTML in the page.

Recommended fix: validate/allowlist hosts on the server and escape all dynamic values before inserting into `innerHTML`, or render the setup help with DOM nodes and `textContent`.

### High: Image-only AI extraction is broken in the client

`extractWithApi` sets `payload.base64Image = image` (`client.js:866-869`) but validates `!payload.image && !payload.text` (`client.js:873`). Since `payload.image` is never set, an image-only call throws `"No image or OCR text available for extraction"` even when `image` exists. Normal uploads often include OCR text, so this can hide until OCR returns an empty string or a caller tries to use the image path alone.

Recommended fix: change the guard to check `!payload.base64Image && !payload.text`. Add a unit test for image-only extraction payload construction.

### Medium: The UI does not use the required colour scheme

`AGENTS.md:26-32` specifies:

- Primary `#FFFFFF`
- Accent `#059669`
- Accent hover `#047857`
- Background `#1F2937`
- Surface `#F9FAFBC9`

The implemented CSS uses a different palette (`styles.css:3-17`), including a near-black background, cream surfaces, and orange accents. This is a direct requirement mismatch.

Recommended fix: update the CSS custom properties to match the required palette and then review contrast states.

### Medium: Uploaded preview is not shown alongside the data entry form

The preview is rendered inside the upload card (`index.html:50-52`), while the review form/table layout is separate (`index.html:78-147`) and does not include the card preview alongside the editable fields. The requirement says the uploaded card preview should be shown alongside the data entry form.

Recommended fix: move or duplicate the active card preview into the review layout, adjacent to the form, so users can compare the image while editing.

### Medium: Correction reuse is exact-card only, not "similar card text"

Corrections are keyed by a hash of the full normalized OCR text (`client.js:48-62`) and `applyLearnedCorrections` explicitly avoids bleed across different cards (`client.js:95-137`). That is safer, but it does not meet the stated "similar card text" behavior. A small OCR variation or same person/card with a changed phone line will produce a different fingerprint and skip learned corrections.

Recommended fix: keep exact-card corrections, but add bounded fuzzy reuse, such as field-level mappings by normalized extracted value plus optional company/email-domain context.

### Medium: Documentation describes an obsolete service-account export path

`README.md:51-58` describes a "Server export (recommended, no sign-in)" using `credentials.json`, but the current export endpoint requires Google OAuth session auth (`app.js:841`) and writes through `saveToUserSheet(auth, ...)` (`app.js:858-876`). The service-account loader remains in `lib/loadServiceAccount.js`, but it is not used by the active export route except for `normalizeSpreadsheetId`.

Recommended fix: update the README to describe the current OAuth-only flow, or add a separate service-account export route if that mode is still intended.

### Medium: Session secret fallback should not exist for production-like runs

The app falls back to `'cardflow-dev-session-secret'` when `SESSION_SECRET` is absent (`app.js:63-73`). `isOAuthConfigured` requires `SESSION_SECRET` (`app.js:78-80`), but the session middleware still runs with the fallback. This is acceptable for quick local development only and risky if someone deploys without noticing.

Recommended fix: fail startup when `NODE_ENV=production` and `SESSION_SECRET` is missing.

### Low: Google Sheets export appends rows one at a time

`/api/export-to-sheet` loops over cards and calls `saveToUserSheet` per card (`app.js:875-877`). Each call also checks/ensures headers (`lib/googleSheet.js:8-26`, `lib/googleSheet.js:35-57`). For batches, this creates unnecessary API calls and can partially write a batch if a later card fails.

Recommended fix: validate all cards first, ensure headers once, then append all rows in one Sheets API request.

### Low: Test coverage is concentrated in validation only

The existing tests cover `lib/validation.js` well (`test/validation.test.js`), but there are no tests for:

- static file exposure / server route behavior
- `normalizeSpreadsheetId` edge cases
- `formatSheetValue` formula and phone sanitization
- client parser behavior for name/position ordering
- mobile-label phone prioritization
- image-only API payload construction
- learned correction persistence and reuse

Recommended fix: add focused tests around the parser/export/security behaviors above. The image-only payload bug would have been caught by a small test.

## Additional Notes

- `node_modules/` is present locally and takes almost all project disk usage (`270M`). `.gitignore` excludes it, which is correct, but if this folder is copied or deployed as-is it adds avoidable weight.
- `.env` and `credentials.json` are present locally despite being ignored. Do not commit them, do not serve them, and rotate credentials if the app has been run while reachable by others.
- `loadGoogleConfig.js` still scans service-account and browser credential locations, but the active UI and server now use OAuth. Removing unused credential loading paths would reduce confusion and lower the chance of secrets being placed in unsafe locations.
