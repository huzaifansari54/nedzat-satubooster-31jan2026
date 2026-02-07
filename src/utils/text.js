// src/utils/text.js — Text Processing Utilities
// -------------------------------------------------

/**
 * Split text into chunks of approximately maxChars
 * Tries to split at natural boundaries (paragraphs, sentences, words)
 * @param {string} str - Text to chunk
 * @param {number} maxChars - Maximum characters per chunk (default: 3800)
 * @returns {string[]} Array of text chunks
 */
function chunkText(str, maxChars = 3800) {
    const s = String(str || '').replace(/\r/g, '').trim();
    const out = [];
    let i = 0;

    while (i < s.length) {
        let end = Math.min(i + maxChars, s.length);

        if (end < s.length) {
            const slice = s.slice(i, end);
            // Try to cut at natural boundaries
            let cut = slice.lastIndexOf('\n\n');
            if (cut < maxChars * 0.5) cut = Math.max(cut, slice.lastIndexOf('. '));
            if (cut < maxChars * 0.5) cut = Math.max(cut, slice.lastIndexOf(' '));
            if (cut >= maxChars * 0.5) end = i + cut + 1;
        }

        const part = s.slice(i, end).trim();
        if (part) out.push(part);
        i = end;
    }

    return out;
}

/**
 * Convert HTML to plain text
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function htmlToText(html) {
    let s = String(html || '');

    // Remove script/style tags
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');

    // Add line breaks for block elements
    s = s.replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|section|article|tr|table)>/gi, '$&\n');

    // Remove remaining tags
    s = s.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    s = s.replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    // Normalize whitespace
    s = s.replace(/\s+/g, ' ').trim();

    return s;
}

/**
 * Rough estimate of token count (for AI models)
 * @param {string} s - Text to estimate
 * @returns {number} Estimated token count
 */
function roughTokenCount(s) {
    return Math.ceil(String(s || '').length / 4);
}

/**
 * Check if text includes any phrase from array (case-insensitive)
 * @param {string} text - Text to search in
 * @param {string[]} arr - Array of phrases to search for
 * @returns {boolean} True if any phrase is found
 */
function includesPhrase(text, arr) {
    const t = String(text || '').toLowerCase();
    return (Array.isArray(arr) ? arr : []).some(p =>
        t.includes(String(p).toLowerCase())
    );
}

/**
 * Clamp text to maximum length
 * @param {string} s - Text to clamp
 * @param {number} maxChars - Maximum characters (default: 4000)
 * @returns {string} Clamped text
 */
function clampText(s, maxChars = 4000) {
    s = String(s || '').replace(/\u0000/g, '').trim();
    return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/**
 * Escape HTML special characters
 * @param {string} s - String to escape
 * @returns {string} Escaped string
 */
function htmlEscape(s = '') {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = {
    chunkText,
    htmlToText,
    roughTokenCount,
    includesPhrase,
    clampText,
    htmlEscape
};
