// src/services/auth/google-oauth.js — Google OAuth Service
// -------------------------------------------------

const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const db = require('../../database');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/**
 * Get Google OAuth client
 * @param {string} redirectUri - Redirect URI
 * @returns {OAuth2Client} Google OAuth client
 */
function getGoogleClient(redirectUri) {
    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

/**
 * Get Google OAuth authorization URL
 * @param {string} redirectUri - Redirect URI
 * @param {string} [state] - Optional state parameter
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(redirectUri, state = '') {
    const client = getGoogleClient(redirectUri);

    return client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ],
        state: state || undefined
    });
}

/**
 * Exchange authorization code for tokens and user info
 * @param {string} code - Authorization code
 * @param {string} redirectUri - Redirect URI
 * @returns {Promise<Object>} User info object
 */
async function exchangeCodeForTokens(code, redirectUri) {
    const client = getGoogleClient(redirectUri);

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    return {
        sub: payload.sub,
        email: payload.email,
        email_verified: payload.email_verified,
        name: payload.name,
        picture: payload.picture
    };
}

/**
 * Find or create user from Google OAuth
 * @param {Object} googleUser - Google user info
 * @returns {Promise<Object>} User object and JWT token
 */
async function findOrCreateGoogleUser(googleUser) {
    const { sub, email, name, picture } = googleUser;

    if (!sub) {
        throw new Error('Google sub (user ID) is required');
    }

    // Try to find user by google_sub
    let user = await db.get(`SELECT * FROM users WHERE google_sub=?`, [sub]);

    if (user) {
        // User exists, return it
        const token = generateJWT(user);
        return { user, token, isNewUser: false };
    }

    // Try to find by email
    if (email) {
        user = await db.get(`SELECT * FROM users WHERE email=?`, [email]);

        if (user) {
            // Link Google account to existing user
            await db.run(
                `UPDATE users
         SET google_sub=?,
             oauth_name=COALESCE(oauth_name, ?),
             oauth_picture=COALESCE(oauth_picture, ?),
             email_verified=1
         WHERE id=?`,
                [sub, name || null, picture || null, user.id]
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
        provider: 'google',
        sub,
        name,
        picture
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
    console.log(`[GOOGLE_OAUTH] Seeding defaults for tenant ${tenantId}`);
}

module.exports = {
    getAuthorizationUrl,
    exchangeCodeForTokens,
    findOrCreateGoogleUser
};
