const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');

/**
 * Extract text from an image using Tesseract OCR.
 * Supports: .png, .jpg, .jpeg, .bmp, .pbm
 * 
 * @param {string} absPath - Absolute path to the image file
 * @param {string} [lang='eng+ara'] - Languages for OCR (default English + Arabic)
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromImage(absPath, lang = 'eng+ara') {
    try {
        // Check if file exists and is readable
        if (!fs.existsSync(absPath)) {
            console.error(`[OCR] File not found: ${absPath}`);
            return '';
        }

        const worker = await createWorker(lang);

        const { data: { text } } = await worker.recognize(absPath);

        await worker.terminate();

        return String(text || '').trim();
    } catch (error) {
        console.error(`[OCR] Error processing image ${absPath}:`, error.message);
        return '';
    }
}

/**
 * Checks if a file extension is supported for OCR.
 * 
 * @param {string} fileName 
 * @returns {boolean}
 */
function isImageForOCR(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const supported = ['.png', '.jpg', '.jpeg', '.bmp', '.pbm'];
    return supported.includes(ext);
}

module.exports = {
    extractTextFromImage,
    isImageForOCR
};
