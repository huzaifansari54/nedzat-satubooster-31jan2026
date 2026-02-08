/**
 * Gupshup App Manager
 * Handles app creation, token retrieval, and embed link generation
 */

const axios = require('axios');
const config = require('../../config');
const { getPartnerToken } = require('./auth');

/**
 * Create a new Gupshup app
 * @param {string} appName - Name for the new app
 * @returns {Promise<string>} App ID
 * @throws {Error} If app creation fails
 */
async function createApp(appName) {
    const token = await getPartnerToken();

    try {
        const resp = await axios.post(
            `${config.gupshup.baseUrl}/partner/app`,
            { name: appName },
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000
            }
        );

        // Try multiple possible app ID fields in response
        const appId = resp.data?.appId
            || resp.data?.id
            || resp.data?.data?.appId;

        if (!appId) {
            throw new Error('appId not found after create app');
        }

        console.log(`[GUPSHUP][APP] Created app: ${appName} (ID: ${appId})`);
        return appId;
    } catch (error) {
        console.error('[GUPSHUP][APP] Create failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

/**
 * Get app token for a specific app
 * @param {string} appId - App ID
 * @returns {Promise<string>} App token
 * @throws {Error} If token retrieval fails
 */
async function getAppToken(appId) {
    const token = await getPartnerToken();

    try {
        const resp = await axios.get(
            `${config.gupshup.baseUrl}/partner/app/${appId}/token`,
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000
            }
        );

        // Try multiple possible token fields in response
        const appToken = resp.data?.token
            || resp.data?.access_token
            || resp.data?.data?.token;

        if (!appToken) {
            throw new Error('app token not found in response');
        }

        return appToken;
    } catch (error) {
        console.error('[GUPSHUP][APP] Get token failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

/**
 * Get embedded signup link for an app
 * @param {string} appId - App ID
 * @returns {Promise<string>} Embed link URL
 * @throws {Error} If link retrieval fails
 */
async function getEmbedLink(appId) {
    const token = await getPartnerToken();

    try {
        const resp = await axios.get(
            `${config.gupshup.baseUrl}/partner/app/${appId}/onboarding/embed/link`,
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000
            }
        );

        // Try multiple possible URL fields in response
        const url = resp.data?.url
            || resp.data?.link
            || resp.data?.data?.url
            || resp.data?.data?.link;

        if (!url) {
            throw new Error('embed link not found in response');
        }

        return url;
    } catch (error) {
        console.error('[GUPSHUP][APP] Get embed link failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

/**
 * Subscribe app to webhook (v3 format)
 * @param {string} appId - App ID
 * @param {string} webhookUrl - Webhook URL to subscribe
 * @returns {Promise<object>} Subscription response
 * @throws {Error} If subscription fails
 */
async function subscribeWebhook(appId, webhookUrl) {
    const token = await getPartnerToken();

    try {
        const resp = await axios.post(
            `${config.gupshup.baseUrl}/partner/app/${appId}/subscription`,
            {
                url: webhookUrl,
                version: 'v3'
            },
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000
            }
        );

        console.log(`[GUPSHUP][APP] Subscribed webhook for app ${appId}: ${webhookUrl}`);
        return resp.data;
    } catch (error) {
        console.error('[GUPSHUP][APP] Subscribe webhook failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

module.exports = {
    createApp,
    getAppToken,
    getEmbedLink,
    subscribeWebhook
};
