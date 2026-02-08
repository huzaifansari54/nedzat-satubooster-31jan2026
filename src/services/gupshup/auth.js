/**
 * Gupshup Partner Portal Authentication
 * Handles partner token management with caching
 */

const axios = require('axios');
const config = require('../../config');

// Token cache
let _partnerToken = null;
let _partnerTokenExp = 0;

/**
 * Get Gupshup Partner Token (with caching)
 * Token is cached for 50 minutes to avoid unnecessary API calls
 * @returns {Promise<string>} Partner token
 * @throws {Error} If credentials are missing or authentication fails
 */
async function getPartnerToken() {
    const now = Date.now();

    // Return cached token if still valid
    if (_partnerToken && now < _partnerTokenExp) {
        return _partnerToken;
    }

    const { email, secret } = config.gupshup;

    if (!email || !secret) {
        throw new Error('Missing GUPSHUP_PARTNER_EMAIL / GUPSHUP_PARTNER_SECRET');
    }

    try {
        const resp = await axios.post(
            `${config.gupshup.baseUrl}/partner/account/login`,
            { email, password: secret },
            { timeout: 20000 }
        );

        // Try multiple possible token fields in response
        const token = resp.data?.token
            || resp.data?.jwt
            || resp.data?.access_token
            || resp.data?.data?.token;

        if (!token) {
            throw new Error('Gupshup partner token not found in response');
        }

        // Cache token for 50 minutes
        _partnerToken = token;
        _partnerTokenExp = now + config.constants.GUPSHUP_TOKEN_EXPIRY_MS;

        return token;
    } catch (error) {
        console.error('[GUPSHUP][AUTH] Login failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

/**
 * Clear cached token (useful for testing or forced refresh)
 */
function clearTokenCache() {
    _partnerToken = null;
    _partnerTokenExp = 0;
}

module.exports = {
    getPartnerToken,
    clearTokenCache
};
