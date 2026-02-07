// src/middleware/cache-control.js — Cache Control Headers
// -------------------------------------------------

/**
 * Set no-cache headers for HTML and auth routes
 * to prevent white page issues until Ctrl+F5
 */
function cacheControl(req, res, next) {
    const path = req.path || '';
    const isHtml = (path === '/' || path.endsWith('.html'));
    const isAuth = path.startsWith('/api/auth/') ||
        path.startsWith('/api/oauth/') ||
        path.includes('/callback');

    if (isHtml || isAuth) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
}

module.exports = {
    cacheControl
};
