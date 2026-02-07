// src/config/cors.js — CORS Configuration
// -------------------------------------------------

/**
 * Get allowed CORS origins from environment
 */
function getCorsOrigins() {
    const defaults = [
        'http://localhost:3099',
        'http://194.32.141.216:3099'
    ];

    const extra = String(process.env.CORS_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    return Array.from(new Set([...defaults, ...extra]));
}

module.exports = {
    getCorsOrigins
};
