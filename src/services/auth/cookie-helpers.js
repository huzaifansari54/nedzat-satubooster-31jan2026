// src/services/auth/cookie-helpers.js — Cookie Management for Auth
// -------------------------------------------------

/**
 * Set authentication cookie
 * @param {Object} res - Express response object
 * @param {Object} req - Express request object
 * @param {string} token - JWT token
 * @returns {void}
 */
function setAuthCookie(res, req, token) {
    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');

    res.cookie('token', token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 3600 * 1000 // 30 days
    });
}

/**
 * Set temporary cookie (for OAuth state, etc.)
 * @param {Object} res - Express response object
 * @param {Object} req - Express request object
 * @param {string} name - Cookie name
 * @param {string} value - Cookie value
 * @param {number} [maxAgeMs=600000] - Max age in milliseconds (default 10 minutes)
 * @param {Object} [opt={}] - Additional options
 * @returns {void}
 */
function setTempCookie(res, req, name, value, maxAgeMs = 10 * 60 * 1000, opt = {}) {
    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
    const sameSite = opt.sameSite || 'lax';

    // Important: sameSite:'none' requires secure:true
    const secure = (sameSite === 'none') ? true : isSecure;

    res.cookie(name, value, {
        httpOnly: true,
        secure,
        sameSite,
        path: '/',
        maxAge: maxAgeMs
    });
}

/**
 * Clear authentication cookie
 * @param {Object} res - Express response object
 * @returns {void}
 */
function clearAuthCookie(res) {
    res.clearCookie('token', { path: '/' });
}

module.exports = {
    setAuthCookie,
    setTempCookie,
    clearAuthCookie
};
