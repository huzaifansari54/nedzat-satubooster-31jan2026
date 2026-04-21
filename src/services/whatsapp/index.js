// ===================================================================
// WHATSAPP SERVICES - MAIN EXPORT
// ===================================================================
// Centralized export for all WhatsApp-related services

const WABAClient = require('./waba-client');
const messageHandler = require('./message-handler');
const mediaHandler = require('./media-handler');
const baileysClient = require('./baileys-client');

/**
 * Create a WABA client instance
 * @param {string} phoneNumberId - WhatsApp phone number ID
 * @param {string} accessToken - Meta access token
 * @returns {WABAClient} WABA client instance
 */
function createWABAClient(phoneNumberId, accessToken) {
    return new WABAClient(phoneNumberId, accessToken);
}

/**
 * Get WABA client for a specific account
 * @param {Object} account - Account object from database
 * @returns {WABAClient|null} WABA client instance or null if not configured
 */
function getWABAClientForAccount(account) {
    if (!account || !account.phone_number_id || !account.access_token) {
        return null;
    }

    return new WABAClient(account.phone_number_id, account.access_token);
}

module.exports = {
    // WABA Client
    WABAClient,
    createWABAClient,
    getWABAClientForAccount,

    // Baileys Client
    startAccount: baileysClient.startAccount,
    stopAccount: baileysClient.stopAccount,
    logoutAccount: baileysClient.logoutAccount,
    getSocket: baileysClient.getSocket,
    setAccStatus: baileysClient.setAccStatus,

    // Message Handler
    parseIncomingMessage: messageHandler.parseIncomingMessage,
    parseMessageStatus: messageHandler.parseMessageStatus,
    saveIncomingMessage: messageHandler.saveIncomingMessage,
    updateMessageStatus: messageHandler.updateMessageStatus,
    getChatHistory: messageHandler.getChatHistory,
    getUnreadCount: messageHandler.getUnreadCount,
    markMessagesAsRead: messageHandler.markMessagesAsRead,
    searchMessages: messageHandler.searchMessages,

    // Media Handler
    MEDIA_TYPES: mediaHandler.MEDIA_TYPES,
    MAX_FILE_SIZES: mediaHandler.MAX_FILE_SIZES,
    SUPPORTED_MIME_TYPES: mediaHandler.SUPPORTED_MIME_TYPES,
    validateMedia: mediaHandler.validateMedia,
    optimizeImage: mediaHandler.optimizeImage,
    createThumbnail: mediaHandler.createThumbnail,
    saveMediaBuffer: mediaHandler.saveMediaBuffer,
    getMediaInfo: mediaHandler.getMediaInfo,
    mediaToDataURL: mediaHandler.mediaToDataURL,
    cleanupOldMedia: mediaHandler.cleanupOldMedia,
    getExtensionFromMimeType: mediaHandler.getExtensionFromMimeType
};
