# CardFlow Proto

## Website Requirements

- Upload a business card image and extract the contact details using OCR.
- The app should extract name, position, company, company address, phone number, and email from the card image.
- The extracted details are shown in editable fields for confirmation and correction.
- Corrections are persisted locally so the app can reuse them for similar card text later.
- A preview of the uploaded card is shown alongside the data entry form.
- Extracted data appears in a table with columns for name, position, company, company address, phone number, and email.
- The website supports Google sign-in and allows sending the reviewed contact directly to a Google Spreadsheet by Spreadsheet ID or URL.
- The parser should prioritize phone numbers labeled `mobile`, `mob`, or `m`, while still handling common phone formats.
- On standard vertical business cards, the person's name is always printed **above** the position/job title; extraction must never swap them.
- Users can upload images by clicking the upload area or by dragging and dropping image files into it.

## Technical Details

- Uses Tesseract.js for browser-based OCR.
- Uses the Google Sheets API client for sheet insertion.
- Local corrections are stored in localStorage.
- Keep the implementation simple and easy to use.
- Contains elegant UI.
- Design should be modern, crisp, and clean.
- NO EMOJIS.

## Colour Scheme

- Background (Abyss Zinc): #09090B
- Background elevated: #18181B
- Surface: #27272A
- Surface strong: #3F3F46
- Body text: #FAFAFA
- Primary headings: #FFFFFF
- Secondary text: #A1A1AA
- Helper text: #52525B
- Accent (Cyber Lime): #CCFF00
- Accent hover: #E6FF66
- Accent soft: rgba(204, 255, 0, 0.1)
- Accent glow: rgba(204, 255, 0, 0.25)
- Success (Electric Mint): #00FF95
- Error (Vivid Rose): #FF0055
- Borders: #27272A


