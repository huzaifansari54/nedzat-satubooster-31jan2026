// src/middleware/error-handler.js — Global Error Handler
// -------------------------------------------------

const { logger } = require('../utils');

/**
 * Global error handling middleware
 * Must be registered last in the middleware chain
 */
function errorHandler(err, req, res, next) {
    logger.error({
        err,
        url: req.url,
        method: req.method,
        user: req.user?.id
    }, '[ERROR] Unhandled exception occurred');

    // Handle specific error types
    if (err.code === 'SIGNUP_DISABLED') {
        return res.status(403).json({
            ok: false,
            error: 'signup_disabled',
            message: 'Registration is currently disabled'
        });
    }

    if (err.code === 'NO_EMAIL') {
        return res.status(400).json({
            ok: false,
            error: 'no_email',
            message: 'Email is required for first sign-in'
        });
    }

    if (err.code === 'SATU_NO_FUNDS') {
        return res.status(402).json({
            ok: false,
            error: 'insufficient_funds',
            message: 'Insufficient SatuCoin balance'
        });
    }

    // Default error response
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal server error';

    res.status(statusCode).json({
        ok: false,
        error: err.code || 'server_error',
        message: process.env.NODE_ENV === 'production' ? 'An error occurred' : message
    });
}

module.exports = {
    errorHandler
};
