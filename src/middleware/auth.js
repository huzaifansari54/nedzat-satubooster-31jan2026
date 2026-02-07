// src/middleware/auth.js — Authentication Middleware
// -------------------------------------------------
// TODO: Move from index.js
// This file will contain: authGuard, adminOnly, optAuth

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');

/**
 * Require authentication
 */
async function authGuard(req, res, next) {
    try {
        const token = req.cookies?.token ||
            (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

        if (!token) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const payload = jwt.verify(token, config.jwtSecret);

        // Check if account is disabled
        try {
            const row = await db.get(`SELECT disabled FROM users WHERE id=?`, [payload.uid]);
            if (row && Number(row.disabled || 0) === 1) {
                res.clearCookie('token', { path: '/' });
                return res.status(403).json({ ok: false, error: 'account_disabled' });
            }
        } catch (err) {
            console.error('[AUTH] Failed to check disabled status:', err);
        }

        req.user = {
            id: payload.uid,
            tenant_id: payload.tid,
            role: payload.role,
            email: payload.email
        };

        next();
    } catch (err) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
}

/**
 * Require admin role
 */
function adminOnly(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
}

/**
 * Optional authentication (doesn't fail if no token)
 */
function optAuth(req, res, next) {
    try {
        const token = req.cookies?.token ||
            (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

        if (token) {
            const payload = jwt.verify(token, config.jwtSecret);
            req.user = {
                id: payload.uid,
                tenant_id: payload.tid,
                role: payload.role,
                email: payload.email
            };
        }
    } catch (err) {
        // Ignore errors for optional auth
    }

    next();
}

module.exports = {
    authGuard,
    adminOnly,
    optAuth
};
