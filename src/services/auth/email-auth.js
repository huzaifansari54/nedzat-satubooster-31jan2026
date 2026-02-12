// src/services/auth/email-auth.js — Email/Password Authentication Service
// -------------------------------------------------

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../../config');
const db = require('../../database');
const { nowSec } = require('../../utils/time');
const { sha256hex } = require('../../utils/crypto');

/**
 * Register a new user with email and password
 * @param {Object} params - Registration parameters
 * @param {string} params.email - User email
 * @param {string} params.password - User password
 * @param {string} [params.name] - Optional user name
 * @returns {Promise<Object>} User object and JWT token
 */
async function registerWithEmail({ email, password, name = null }) {
    // Check if open signup is enabled
    const enabled = (await getSetting('open_signup', 1) || '0') === '1';
    if (!enabled) {
        const err = new Error('Registration is currently disabled');
        err.code = 'SIGNUP_DISABLED';
        throw err;
    }

    const role = (await getSetting('open_signup_role', 1) || 'user');

    // Check if email already exists
    const existing = await db.get(`SELECT id FROM users WHERE email=?`, [email]);
    if (existing) {
        throw new Error('Email already registered');
    }

    // Hash password
    const passHash = await bcrypt.hash(password, 10);

    // Create tenant
    const local = (email.split('@')[0] || 'user').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    const tenantName = `${local || 'user'}-${uniqueSuffix}`;

    const tIns = await db.run(
        `INSERT INTO tenants(name,created_at) VALUES(?,?)`,
        [tenantName, Date.now()]
    );
    const tid = tIns.lastID;

    // Seed defaults for tenant
    await seedDefaultsForTenant(tid);

    // Check if email is auto-verified
    const emailVerified = isAutoVerifiedEmail(email) ? 1 : 0;

    // Create user
    const uIns = await db.run(
        `INSERT INTO users(tenant_id,email,pass_hash,role,created_at,email_verified,oauth_name)
     VALUES(?,?,?,?,?,?,?)`,
        [tid, email, passHash, role, Date.now(), emailVerified, name || null]
    );

    const user = await db.get(`SELECT * FROM users WHERE id=?`, [uIns.lastID]);

    // Generate JWT
    const token = jwt.sign(
        {
            uid: user.id,
            tid: user.tenant_id,
            role: user.role,
            email: user.email
        },
        config.jwtSecret,
        { expiresIn: '30d' }
    );

    return { user, token, emailVerified };
}

/**
 * Login with email and password
 * @param {Object} params - Login parameters
 * @param {string} params.email - User email
 * @param {string} params.password - User password
 * @returns {Promise<Object>} User object and JWT token
 */
async function loginWithEmail({ email, password }) {
    const user = await db.get(`SELECT * FROM users WHERE email=?`, [email]);

    if (!user || !user.pass_hash) {
        throw new Error('Invalid email or password');
    }

    // Check if account is disabled
    if (Number(user.disabled || 0) === 1) {
        const err = new Error('Account is disabled');
        err.code = 'ACCOUNT_DISABLED';
        throw err;
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.pass_hash);
    if (!valid) {
        throw new Error('Invalid email or password');
    }

    // Generate JWT
    const token = jwt.sign(
        {
            uid: user.id,
            tid: user.tenant_id,
            role: user.role,
            email: user.email
        },
        config.jwtSecret,
        { expiresIn: '30d' }
    );

    return { user, token };
}

/**
 * Check if email is auto-verified (whitelisted domains)
 * @param {string} email - Email to check
 * @returns {boolean} True if email is auto-verified
 */
function isAutoVerifiedEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return e.endsWith('@deshti.kz') || e.endsWith('@satubooster.kz');
}

/**
 * Helper to get setting value
 * @param {string} key - Setting key
 * @param {number} tenantId - Tenant ID (1 for global)
 * @returns {Promise<string|null>} Setting value
 */
async function getSetting(key, tenantId) {
    const row = await db.get(
        `SELECT value FROM settings WHERE key=? AND tenant_id=?`,
        [key, tenantId]
    );
    return row ? row.value : null;
}

const { seedDefaultsForTenant } = require('../../database/seeds/defaults');

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
function generateJWT(user) {
    return jwt.sign(
        {
            uid: user.id || user.uid,
            tid: user.tenant_id || user.tid,
            role: user.role,
            email: user.email
        },
        config.jwtSecret,
        { expiresIn: '30d' }
    );
}

module.exports = {
    registerWithEmail,
    loginWithEmail,
    isAutoVerifiedEmail,
    generateJWT
};
