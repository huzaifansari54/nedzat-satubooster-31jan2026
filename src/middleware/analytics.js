// src/middleware/analytics.js — Analytics Tracking Middleware
// -------------------------------------------------
const crypto = require('crypto');

/**
 * Set stable visitor ID cookie (aid) for analytics
 */
function analyticsMiddleware(req, res, next) {
    try {
        const hasAid = req.cookies && req.cookies.aid;

        if (!hasAid) {
            const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
            const aid = crypto.randomBytes(12).toString('hex'); // 24 chars

            res.cookie('aid', aid, {
                httpOnly: true,
                secure: isSecure,
                sameSite: 'lax',
                path: '/',
                maxAge: 90 * 24 * 3600 * 1000 // 90 days
            });

            // Make aid available in this request
            req.cookies = req.cookies || {};
            req.cookies.aid = aid;
        }
    } catch (err) {
        // Don't fail the request if analytics cookie fails
        console.error('[ANALYTICS] Failed to set aid cookie:', err);
    }

    next();
}

module.exports = {
    analyticsMiddleware
};
