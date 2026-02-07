/**
 * Instagram Service
 * Main export for Instagram-related functionality
 */

const InstagramAPIClient = require('./api-client');
const webhook = require('./webhook');

module.exports = {
    // API Client
    InstagramAPIClient,

    // Webhook handlers
    verifyWebhookSignature: webhook.verifyWebhookSignature,
    handleWebhookVerification: webhook.handleWebhookVerification,
    processWebhookPayload: webhook.processWebhookPayload,

    // Message operations
    saveIncomingMessage: webhook.saveIncomingMessage,
    saveOutgoingMessage: webhook.saveOutgoingMessage,

    // Logging and analytics
    logInstagramAction: webhook.logInstagramAction,

    // Settings and connections
    getInstagramConnection: webhook.getInstagramConnection,
    getInstagramSettings: webhook.getInstagramSettings,

    // Utilities
    cleanupDedupRecords: webhook.cleanupDedupRecords,
    isDuplicate: webhook.isDuplicate
};
