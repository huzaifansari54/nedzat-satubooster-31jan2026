// src/services/auth/apple-oauth.js — Apple OAuth Service
// -------------------------------------------------

const fs = require('fs');
const { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } = require('jose');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const db = require('../../database');

const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const APPLE_KEY_ID = process.env.APPLE_KEY_ID || '';
const APPLE_PRIVATE_KEY_PATH = process.env.APPLE_PRIVATE_KEY_PATH || '';

// Load Apple private key
let APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!APPLE_PRIVATE_KEY && APPLE_PRIVATE_KEY_PATH) {
    try {
        APPLE_PRIVATE_KEY = fs.readFileSync(APPLE_PRIVATE_KEY_PATH, 'utf8');
    } catch (e) {
        console.error('[APPLE_OAUTH] Cannot read APPLE_PRIVATE_KEY_PATH:', e?.message || e);
    }
}

APPLE_PRIVATE_KEY = String(APPLE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();

// Apple JWKS for verifying ID tokens
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// Cache for client secret
let _appleSecretCache = { value: null, exp: 0 };

/**
 * Generate Apple client secret (JWT signed with ES256)
 * @returns {Promise<string>} Client secret JWT
 */
async function getAppleClientSecret() {
    if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
        return '';
    }

    const now = Math.floor(Date.now() / 1000);

    // Return cached secret if still valid
    if (_appleSecretCache.value && now < (_appleSecretCache.exp - 30)) {
        return _appleSecretCache.value;
    }

    // Import private key
    const pk = await importPKCS8(APPLE_PRIVATE_KEY, 'ES256');
    const exp = now + 6 * 60; // 6 minutes (can be longer, but safer this way)

    // Create JWT
    const jwtStr = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: APPLE_KEY_ID })
        .setIssuer(APPLE_TEAM_ID)
        .setSubject(APPLE_CLIENT_ID)
        .setAudience('https://appleid.apple.com')
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(pk);

    _appleSecretCache = { value: jwtStr, exp };
    return jwtStr;
}

/**
 * Verify Apple ID token
 * @param {string} idToken - Apple ID token
 * @returns {Promise<Object>} Verified payload
 */
async function verifyAppleIdToken(idToken) {
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
        issuer: 'https://appleid.apple.com',
        audience: APPLE_CLIENT_ID
    });

    return {
        sub: payload.sub,
        email: payload.email,
        email_verified: payload.email_verified === 'true' || payload.email_verified === true,
        is_private_email: payload.is_private_email === 'true' || payload.is_private_email === true
    };
}

/**
 * Exchange authorization code for tokens
 * @param {string} code - Authorization code
 * @param {string} redirectUri - Redirect URI
 * @returns {Promise<Object>} Tokens and user info
 */
async function exchangeCodeForTokens(code, redirectUri) {
    const clientSecret = await getAppleClientSecret();

    const params = new URLSearchParams({
        client_id: APPLE_CLIENT_ID,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    });

    const response = await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Apple token exchange failed: ${error}`);
    }

    const data = await response.json();

    // Verify ID token
    const userInfo = await verifyAppleIdToken(data.id_token);

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        id_token: data.id_token,
        userInfo
    };
}

/**
 * Find or create user from Apple OAuth
 * @param {Object} appleUser - Apple user info
 * @param {Object} [userForm] - Optional user form data (name from first sign-in)
 * @returns {Promise<Object>} User object and JWT token
 */
async function findOrCreateAppleUser(appleUser, userForm = {}) {
    const { sub, email } = appleUser;
    const name = userForm?.name || null;

    if (!sub) {
        throw new Error('Apple sub (user ID) is required');
    }

    // Try to find user by apple_sub
    let user = await db.get(`SELECT * FROM users WHERE apple_sub=?`, [sub]);

    if (user) {
        // User exists, return it
        const token = generateJWT(user);
        return { user, token, isNewUser: false };
    }

    // Try to find by email
    if (email) {
        user = await db.get(`SELECT * FROM users WHERE email=?`, [email]);

        if (user) {
            // Link Apple account to existing user
            await db.run(
                `UPDATE users
         SET apple_sub=?,
             oauth_name=COALESCE(oauth_name, ?),
             email_verified=1
         WHERE id=?`,
                [sub, name, user.id]
            );

            user = await db.get(`SELECT * FROM users WHERE id=?`, [user.id]);
            const token = generateJWT(user);
            return { user, token, isNewUser: false };
        }
    }

    // Email is required for first sign-in
    if (!email) {
        const err = new Error('Email is required for first sign-in');
        err.code = 'NO_EMAIL';
        throw err;
    }

    // Create new user and tenant
    const result = await createTenantAndUserForOAuth({
        email,
        provider: 'apple',
        sub,
        name,
        picture: null
    });

    const token = generateJWT(result);
    return { user: result, token, isNewUser: true };
}

/**
 * Create tenant and user for OAuth sign-in
 * @param {Object} params - User parameters
 * @returns {Promise<Object>} User object
 */
async function createTenantAndUserForOAuth({ email, provider, sub, name, picture }) {
    // Check if open signup is enabled
    const enabled = (await getSetting('open_signup', 1) || '0') === '1';
    if (!enabled) {
        const err = new Error('Registration is currently disabled');
        err.code = 'SIGNUP_DISABLED';
        throw err;
    }

    const role = (await getSetting('open_signup_role', 1) || 'user');

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

    // Create user
    const col = provider === 'google' ? 'google_sub' : 'apple_sub';

    const uIns = await db.run(
        `INSERT INTO users(tenant_id,email,pass_hash,role,created_at,email_verified,${col},oauth_name,oauth_picture)
     VALUES(?,?,?,?,?,?,?,?,?)`,
        [tid, email, null, role, Date.now(), 1, sub, name || null, picture || null]
    );

    return await db.get(`SELECT * FROM users WHERE id=?`, [uIns.lastID]);
}

/**
 * Generate JWT token for user
 * @param {Object} user - User object
 * @returns {string} JWT token
 */
function generateJWT(user) {
    return jwt.sign(
        {
            uid: user.id,
            tid: user.tenant_id,
            role: user.role,
            email: user.email
        },
        config.jwtSecret,
        { expiresIn: '30d' }
    );
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

/**
 * Seed default data for new tenant
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<void>}
 */
async function seedDefaultsForTenant(tenantId) {
    // TODO: Implement default seeding logic
    console.log(`[APPLE_OAUTH] Seeding defaults for tenant ${tenantId}`);
}

module.exports = {
    getAppleClientSecret,
    verifyAppleIdToken,
    exchangeCodeForTokens,
    findOrCreateAppleUser
};
