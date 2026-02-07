// src/utils/validators.js — Input Validation Utilities
// -------------------------------------------------

/**
 * Check if email is auto-verified (whitelisted domains)
 * @param {string} email - Email address
 * @returns {boolean} True if auto-verified
 */
function isAutoVerifiedEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return e.endsWith('@deshti.kz') || e.endsWith('@satubooster.kz');
}

/**
 * Validate email format
 * @param {string} email - Email address
 * @returns {boolean} True if valid email format
 */
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(String(email || '').trim());
}

/**
 * Validate phone number (E.164 format)
 * @param {string} phone - Phone number
 * @returns {boolean} True if valid phone
 */
function isValidPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
}

/**
 * Sanitize filename (remove dangerous characters)
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 */
function sanitizeFilename(filename) {
    return String(filename || '')
        .replace(/[^a-z0-9_.-]/gi, '_')
        .slice(0, 255);
}

/**
 * Validate URL format
 * @param {string} url - URL string
 * @returns {boolean} True if valid URL
 */
function isValidURL(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate JID (Jabber ID for WhatsApp)
 * @param {string} jid - JID string
 * @returns {boolean} True if valid JID
 */
function isValidJID(jid) {
    const s = String(jid || '').trim();
    return s.includes('@') && s.length > 3;
}

/**
 * Check if string is numeric
 * @param {string} str - String to check
 * @returns {boolean} True if numeric
 */
function isNumeric(str) {
    return !isNaN(parseFloat(str)) && isFinite(str);
}

/**
 * Validate hex color code
 * @param {string} color - Color code
 * @returns {boolean} True if valid hex color
 */
function isValidHexColor(color) {
    return /^#[0-9A-F]{6}$/i.test(String(color || ''));
}

module.exports = {
    isAutoVerifiedEmail,
    isValidEmail,
    isValidPhone,
    sanitizeFilename,
    isValidURL,
    isValidJID,
    isNumeric,
    isValidHexColor
};
