const { validateBusinessCard } = require('../lib/validation');

const extractedCard = {
  name: '  Priya Sharma ',
  jobTitle: 'Managing Director',
  company: 'Northstar Media',
  email: 'priya.sharma@northstar-media.co.uk',
  phone: 'M +44 20 7946 0958',
  website: 'www.northstar-media.co.uk',
  address: '45 King Street, London EC2V 8AB',
};

const validation = validateBusinessCard(extractedCard, { defaultCountry: 'GB' });

console.log(JSON.stringify(validation, null, 2));

/*
Example output:

{
  "valid": true,
  "confidence": 100,
  "warnings": [],
  "issues": [],
  "normalizedData": {
    "name": "Priya Sharma",
    "jobTitle": "Managing Director",
    "company": "Northstar Media",
    "email": "priya.sharma@northstar-media.co.uk",
    "phone": "+44 20 7946 0958",
    "website": "https://www.northstar-media.co.uk",
    "address": "45 King Street, London EC2V 8AB"
  },
  "originalData": {
    "name": "  Priya Sharma ",
    "jobTitle": "Managing Director",
    "company": "Northstar Media",
    "email": "priya.sharma@northstar-media.co.uk",
    "phone": "M +44 20 7946 0958",
    "website": "www.northstar-media.co.uk",
    "address": "45 King Street, London EC2V 8AB"
  },
  "corrections": [
    {
      "field": "name",
      "original": "  Priya Sharma ",
      "normalized": "Priya Sharma",
      "reason": "Trimmed whitespace and removed obvious OCR/control artifacts."
    },
    {
      "field": "phone",
      "original": "M +44 20 7946 0958",
      "normalized": "+44 20 7946 0958",
      "reason": "Normalized with libphonenumber-js."
    },
    {
      "field": "website",
      "original": "www.northstar-media.co.uk",
      "normalized": "https://www.northstar-media.co.uk",
      "reason": "Added protocol and normalized URL formatting."
    }
  ],
  "requiresReview": false
}
*/
