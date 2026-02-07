// src/utils/crypto.js — Cryptographic Utilities
// -------------------------------------------------

const crypto = require('crypto');

/**
 * Generate SHA-256 hash of a string
 * @param {string} s - String to hash
 * @returns {string} Hex-encoded hash
 */
function sha256hex(s) {
    return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

/**
 * Generate a random token
 * @param {number} bytes - Number of random bytes (default: 32)
 * @returns {string} Hex-encoded random token
 */
function generateToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a random UUID
 * @returns {string} UUID v4
 */
function generateUUID() {
    return crypto.randomUUID();
}

module.exports = {
    sha256hex,
    generateToken,
    generateUUID
};
