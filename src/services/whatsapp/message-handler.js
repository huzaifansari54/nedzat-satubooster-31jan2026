// ===================================================================
// WHATSAPP MESSAGE HANDLER
// ===================================================================
// Purpose: Process incoming WhatsApp messages from webhooks
// Handles message parsing, validation, and routing

const db = require('../../database');
const { nowSec } = require('../../utils/time');

/**
 * Parse incoming WhatsApp webhook message
 * @param {Object} webhookData - Raw webhook data from Meta
 * @returns {Object|null} Parsed message object or null if invalid
 */
function parseIncomingMessage(webhookData) {
    try {
        const entry = webhookData?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;

        if (!value) return null;

        // Extract message data
        const messages = value?.messages;
        if (!messages || messages.length === 0) return null;

        const message = messages[0];
        const from = message?.from; // Sender phone number
        const messageId = message?.id;
        const timestamp = message?.timestamp;
        const type = message?.type; // text, image, video, audio, document, etc.

        // Extract message content based on type
        let content = null;
        let mediaId = null;
        let caption = null;

        switch (type) {
            case 'text':
                content = message?.text?.body;
                break;

            case 'image':
                mediaId = message?.image?.id;
                caption = message?.image?.caption;
                break;

            case 'video':
                mediaId = message?.video?.id;
                caption = message?.video?.caption;
                break;

            case 'audio':
                mediaId = message?.audio?.id;
                break;

            case 'document':
                mediaId = message?.document?.id;
                caption = message?.document?.caption;
                break;

            case 'voice':
                mediaId = message?.voice?.id;
                break;

            case 'sticker':
                mediaId = message?.sticker?.id;
                break;

            case 'location':
                content = JSON.stringify({
                    latitude: message?.location?.latitude,
                    longitude: message?.location?.longitude,
                    name: message?.location?.name,
                    address: message?.location?.address
                });
                break;

            case 'contacts':
                content = JSON.stringify(message?.contacts);
                break;

            case 'reaction':
                content = JSON.stringify({
                    message_id: message?.reaction?.message_id,
                    emoji: message?.reaction?.emoji
                });
                break;

            default:
                content = JSON.stringify(message);
        }

        return {
            messageId,
            from,
            timestamp: parseInt(timestamp) || nowSec(),
            type,
            content,
            mediaId,
            caption,
            rawMessage: message
        };
    } catch (error) {
        console.error('[MessageHandler] Parse error:', error);
        return null;
    }
}

/**
 * Parse incoming message status update (sent, delivered, read, failed)
 * @param {Object} webhookData - Raw webhook data from Meta
 * @returns {Object|null} Parsed status object or null if invalid
 */
function parseMessageStatus(webhookData) {
    try {
        const entry = webhookData?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;

        if (!value) return null;

        const statuses = value?.statuses;
        if (!statuses || statuses.length === 0) return null;

        const status = statuses[0];

        return {
            messageId: status?.id,
            status: status?.status, // sent, delivered, read, failed
            timestamp: parseInt(status?.timestamp) || nowSec(),
            recipientId: status?.recipient_id,
            errors: status?.errors || []
        };
    } catch (error) {
        console.error('[MessageHandler] Parse status error:', error);
        return null;
    }
}

/**
 * Save incoming message to database
 * @param {Object} parsedMessage - Parsed message object
 * @param {number} accountId - WhatsApp account ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<number>} Message ID in database
 */
async function saveIncomingMessage(parsedMessage, accountId, tenantId) {
    const { messageId, from, timestamp, type, content, mediaId, caption } = parsedMessage;

    // Check if contact exists, create if not
    let contact = await db.get(
        'SELECT id FROM contacts WHERE phone = ? AND tenant_id = ?',
        [from, tenantId]
    );

    if (!contact) {
        await db.run(
            `INSERT INTO contacts (tenant_id, phone, name, created_at)
       VALUES (?, ?, ?, ?)`,
            [tenantId, from, from, nowSec()]
        );
        contact = await db.get(
            'SELECT id FROM contacts WHERE phone = ? AND tenant_id = ?',
            [from, tenantId]
        );
    }

    // Save message
    const result = await db.run(
        `INSERT INTO messages (
      tenant_id, account_id, contact_id, wamid, direction, 
      type, body, media_id, caption, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tenantId,
            accountId,
            contact.id,
            messageId,
            'incoming',
            type,
            content,
            mediaId,
            caption,
            'received',
            timestamp
        ]
    );

    return result.lastID;
}

/**
 * Update message status in database
 * @param {Object} statusUpdate - Parsed status update
 * @returns {Promise<void>}
 */
async function updateMessageStatus(statusUpdate) {
    const { messageId, status, timestamp } = statusUpdate;

    await db.run(
        `UPDATE messages 
     SET status = ?, updated_at = ?
     WHERE wamid = ?`,
        [status, timestamp, messageId]
    );
}

/**
 * Get chat history for a contact
 * @param {number} contactId - Contact ID
 * @param {number} limit - Number of messages to retrieve
 * @returns {Promise<Array>} Array of messages
 */
async function getChatHistory(contactId, limit = 50) {
    const messages = await db.all(
        `SELECT * FROM messages 
     WHERE contact_id = ? 
     ORDER BY created_at DESC 
     LIMIT ?`,
        [contactId, limit]
    );

    return messages.reverse(); // Return in chronological order
}

/**
 * Get unread message count for a contact
 * @param {number} contactId - Contact ID
 * @returns {Promise<number>} Unread count
 */
async function getUnreadCount(contactId) {
    const result = await db.get(
        `SELECT COUNT(*) as count FROM messages 
     WHERE contact_id = ? 
     AND direction = 'incoming' 
     AND status != 'read'`,
        [contactId]
    );

    return result?.count || 0;
}

/**
 * Mark messages as read
 * @param {number} contactId - Contact ID
 * @returns {Promise<void>}
 */
async function markMessagesAsRead(contactId) {
    await db.run(
        `UPDATE messages 
     SET status = 'read', updated_at = ?
     WHERE contact_id = ? 
     AND direction = 'incoming' 
     AND status != 'read'`,
        [nowSec(), contactId]
    );
}

/**
 * Search messages by content
 * @param {number} tenantId - Tenant ID
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 * @returns {Promise<Array>} Array of matching messages
 */
async function searchMessages(tenantId, query, limit = 50) {
    const messages = await db.all(
        `SELECT m.*, c.name as contact_name, c.phone as contact_phone
     FROM messages m
     JOIN contacts c ON m.contact_id = c.id
     WHERE m.tenant_id = ? 
     AND (m.body LIKE ? OR m.caption LIKE ?)
     ORDER BY m.created_at DESC
     LIMIT ?`,
        [tenantId, `%${query}%`, `%${query}%`, limit]
    );

    return messages;
}

module.exports = {
    parseIncomingMessage,
    parseMessageStatus,
    saveIncomingMessage,
    updateMessageStatus,
    getChatHistory,
    getUnreadCount,
    markMessagesAsRead,
    searchMessages
};
