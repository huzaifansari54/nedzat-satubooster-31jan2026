// src/config/oauth.js — OAuth Configuration
// -------------------------------------------------

const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { createRemoteJWKSet } = require('jose');

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/**
 * Get Google OAuth2 Client
 */
function getGoogleClient(publicBaseUrl) {
    const redirectUri = `${publicBaseUrl}/api/auth/google/callback`;
    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

// Apple OAuth
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const APPLE_KEY_ID = process.env.APPLE_KEY_ID || '';
const APPLE_PRIVATE_KEY_PATH = process.env.APPLE_PRIVATE_KEY_PATH || '';

// Load Apple private key from file or environment
let APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!APPLE_PRIVATE_KEY && APPLE_PRIVATE_KEY_PATH) {
    try {
        APPLE_PRIVATE_KEY = fs.readFileSync(APPLE_PRIVATE_KEY_PATH, 'utf8');
    } catch (e) {
        console.error('[APPLE_OAUTH] cannot read APPLE_PRIVATE_KEY_PATH:', e?.message || e);
    }
}

// Normalize the private key (handle escaped newlines)
APPLE_PRIVATE_KEY = String(APPLE_PRIVATE_KEY || '')
    .replace(/\\\\n/g, '\n')
    .replace(/\\r/g, '')
    .trim();

// Apple JWKS for token verification
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

module.exports = {
    // Google
    google: {
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        getClient: getGoogleClient
    },

    // Apple
    apple: {
        clientId: APPLE_CLIENT_ID,
        teamId: APPLE_TEAM_ID,
        keyId: APPLE_KEY_ID,
        privateKey: APPLE_PRIVATE_KEY,
        jwks: APPLE_JWKS
    }
};
