const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const { fileToDataURL } = require('../../utils/file');

// Base directory for temp files (renders)
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

/**
 * Renders the first page of a PDF into a PNG file.
 * Returns the absolute path to the PNG or null if it fails.
 * 
 * @param {string} absPdfPath 
 * @returns {Promise<string|null>}
 */
async function pdfFirstPageToPng(absPdfPath) {
    return new Promise((resolve) => {
        try {
            const outBase = path.join(UPLOAD_DIR, path.basename(absPdfPath, '.pdf') + '-p1');
            // Requires 'pdftoppm' tool (from poppler-utils)
            execFile('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', absPdfPath, outBase], { timeout: 15000 }, (err) => {
                if (err) return resolve(null);
                const pngPath = outBase + '.png';
                fs.access(pngPath, fs.constants.R_OK, (e) => resolve(e ? null : pngPath));
            });
        } catch (_) {
            resolve(null);
        }
    });
}

/**
 * Extracts text from a PDF.
 * Uses pdf-parse first; if the result is empty or too short, falls back to OCR 
 * via OpenAI Vision on the first page.
 * 
 * @param {string} absPdfPath 
 * @param {string} openaiKey 
 * @returns {Promise<string>}
 */
async function extractPdfText(absPdfPath, openaiKey) {
    let pdfText = '';

    // 1) Direct text extraction via pdf-parse
    try {
        const buf = await fsp.readFile(absPdfPath);
        const parsed = await pdfParse(buf);
        pdfText = String(parsed?.text || '').trim();
    } catch (_) { }

    // 2) OCR fallback (first page) via GPT-4o-mini Vision
    if ((!pdfText || pdfText.replace(/\s+/g, '').length < 20) && openaiKey) {
        try {
            const png = await pdfFirstPageToPng(absPdfPath);
            if (png) {
                const openai = new OpenAI({ apiKey: openaiKey });
                const dataURL = await fileToDataURL(png, 'image/png');
                const comp = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    temperature: 0,
                    max_tokens: 500,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Extract text from this PDF page (OCR) and briefly describe its content.' },
                            { type: 'image_url', image_url: { url: dataURL } }
                        ]
                    }]
                });
                const v = String(comp.choices?.[0]?.message?.content || '').trim();
                if (v) pdfText = v;
            }
        } catch (_) { }
    }

    return pdfText.trim();
}

module.exports = {
    extractPdfText,
    pdfFirstPageToPng
};
