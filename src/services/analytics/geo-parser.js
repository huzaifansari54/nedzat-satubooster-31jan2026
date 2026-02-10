let geoip = null;
try {
    geoip = require('geoip-lite');
} catch (e) {
    console.warn('[GEO] geoip-lite not installed, using fallback');
}

/**
 * Get client IP address from request.
 * Handles Cloudflare and proxies.
 * @param {Object} req 
 * @returns {string}
 */
function getClientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || req.socket?.remoteAddress || '';
}

/**
 * Get country code from request (Cloudflare) or IP (GeoIP).
 * @param {Object} req 
 * @param {string} ip 
 * @returns {string} Country code (e.g. 'US', 'KZ')
 */
function getCountry(req, ip) {
    // Cloudflare priority
    const cf = String(req.headers['cf-ipcountry'] || '').trim();
    if (cf && cf !== 'XX') return cf;

    // geoip-lite fallback
    try {
        if (geoip && ip) {
            const g = geoip.lookup(ip);
            if (g && g.country) return g.country;
        }
    } catch (_) { }

    return '';
}

module.exports = {
    getClientIp,
    getCountry
};
