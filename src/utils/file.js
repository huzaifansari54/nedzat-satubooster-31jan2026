// src/utils/file.js — File Utilities
// -------------------------------------------------

const fsp = require('fs').promises;

/**
 * Convert file to Data URL (base64)
 * @param {string} absPath - Absolute path to file
 * @param {string} mime - MIME type (default: 'application/octet-stream')
 * @returns {Promise<string>} Data URL
 */
async function fileToDataURL(absPath, mime = 'application/octet-stream') {
    const buf = await fsp.readFile(absPath);
    const b64 = buf.toString('base64');
    return `data:${mime};base64,${b64}`;
}

/**
 * Check if file exists
 * @param {string} path - File path
 * @returns {Promise<boolean>} True if file exists
 */
async function fileExists(path) {
    try {
        await fsp.access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get file size in bytes
 * @param {string} path - File path
 * @returns {Promise<number>} File size in bytes
 */
async function getFileSize(path) {
    const stats = await fsp.stat(path);
    return stats.size;
}

/**
 * Ensure directory exists (create if needed)
 * @param {string} dirPath - Directory path
 */
async function ensureDir(dirPath) {
    try {
        await fsp.mkdir(dirPath, { recursive: true });
    } catch (e) {
        // Ignore if already exists
    }
}

module.exports = {
    fileToDataURL,
    fileExists,
    getFileSize,
    ensureDir
};
