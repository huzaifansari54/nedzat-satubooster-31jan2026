const fsp = require('fs').promises;
const path = require('path');
const { xlsxToText } = require('./excel-parser');

let officeParser = null;
try {
    officeParser = require('officeparser');
} catch (e) {
    console.warn('[DOC-PARSER] officeparser not installed, DOCX/PPTX parsing disabled:', e.message);
}

/**
 * Universal office document text extractor.
 * Supports: .txt, .csv, .md, .log, .xlsx, .xls, .docx, .pptx
 * 
 * @param {string} absPath - Absolute path to file
 * @param {string} [fileName] - Original filename (used for extension check)
 * @returns {Promise<string>} Extracted text
 */
async function extractOfficeText(absPath, fileName) {
    const ext = path.extname(String(fileName || absPath)).toLowerCase();
    const st = await fsp.stat(absPath).catch(() => null);
    if (!st) return '';

    // Prevent processing massive files (>25MB) to avoid CPU/memory spikes
    if (st.size > 25 * 1024 * 1024) return '';

    // Plain text formats
    if (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.log') {
        return (await fsp.readFile(absPath, 'utf8').catch(() => '')).trim();
    }

    // Excel formats
    if (ext === '.xlsx' || ext === '.xls') {
        try {
            return xlsxToText(absPath);
        } catch (_) {
            return '';
        }
    }

    // Word / PowerPoint formats
    if (ext === '.docx' || ext === '.pptx') {
        if (!officeParser) return '';
        try {
            // Modern officeparser versions support Async
            if (officeParser.parseOfficeAsync) {
                return String(await officeParser.parseOfficeAsync(absPath) || '').trim();
            }

            // Fallback for older Callback-based versions
            if (officeParser.parseOffice) {
                const t = await new Promise((resolve, reject) =>
                    officeParser.parseOffice(absPath, (err, text) => err ? reject(err) : resolve(text))
                );
                return String(t || '').trim();
            }

            // Specific docx parser check if generic one fails
            if (ext === '.docx' && officeParser.parseDocx) {
                const t = await new Promise((resolve, reject) =>
                    officeParser.parseDocx(absPath, (err, text) => err ? reject(err) : resolve(text))
                );
                return String(t || '').trim();
            }
        } catch (_) {
            return '';
        }
    }

    return '';
}

module.exports = {
    extractOfficeText
};
