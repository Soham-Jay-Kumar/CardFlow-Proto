const sharp = require('sharp');

/**
 * Decode a base64 string or data URL into a raw image buffer.
 * @param {string} base64Image - Raw base64 or data:image/...;base64,... URL
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
function decodeBase64Image(base64Image) {
  const trimmed = String(base64Image || '').trim();
  if (!trimmed) {
    throw Object.assign(new Error('base64Image is empty'), { code: 'INVALID_IMAGE' });
  }

  const dataUrlMatch = trimmed.match(/^data:(image\/[\w.+-]+);base64,(.+)$/is);
  if (dataUrlMatch) {
    const base64 = dataUrlMatch[2].replace(/\s/g, '');
    return {
      mimeType: dataUrlMatch[1].toLowerCase(),
      buffer: Buffer.from(base64, 'base64'),
    };
  }

  const base64 = trimmed.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw Object.assign(
      new Error('base64Image is not valid base64 or a data URL'),
      { code: 'INVALID_IMAGE' },
    );
  }

  return {
    mimeType: 'image/jpeg',
    buffer: Buffer.from(base64, 'base64'),
  };
}

/**
 * Grayscale + contrast boost for clearer vision/OCR on business cards.
 * @param {Buffer} buffer
 * @returns {Promise<{ buffer: Buffer, dataUrl: string }>}
 */
async function preprocessImageForVision(buffer) {
  const processed = await sharp(buffer)
    .rotate()
    .grayscale()
    .normalize()
    .linear(1.35, -(128 * 0.35))
    .sharpen({ sigma: 0.8 })
    .png()
    .toBuffer();

  return {
    buffer: processed,
    dataUrl: `data:image/png;base64,${processed.toString('base64')}`,
  };
}

module.exports = { decodeBase64Image, preprocessImageForVision };
