/**
 * Gupshup Service
 * Main export for Gupshup Partner Portal integration
 * 
 * This service handles:
 * - Partner authentication and token management
 * - App creation and management
 * - Webhook processing (v3 format, Meta-compatible)
 * - Message sending via Gupshup API
 * 
 * @module services/gupshup
 */

const auth = require('./auth');
const appManager = require('./app-manager');
const webhook = require('./webhook');
const messageSender = require('./message-sender');

module.exports = {
    // Authentication
    getPartnerToken: auth.getPartnerToken,
    clearTokenCache: auth.clearTokenCache,

    // App Management
    createApp: appManager.createApp,
    getAppToken: appManager.getAppToken,
    getEmbedLink: appManager.getEmbedLink,
    subscribeWebhook: appManager.subscribeWebhook,

    // Webhook Processing
    processWebhook: webhook.processWebhook,
    autoBindPhoneNumberId: webhook.autoBindPhoneNumberId,

    // Message Sending
    sendMessage: messageSender.sendMessage
};
