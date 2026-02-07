/**
 * Instagram Webhook Handler
 * Processes incoming webhooks from Meta's Instagram Graph API
 */

const crypto = require('crypto');
const { run, get, all } = require('../../database');
const InstagramAPIClient = require('./api-client');

/**
 * Verify webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - X-Hub-Signature-256 header value
 * @param {string} appSecret - Instagram App Secret
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(payload, signature, appSecret) {
    if (!signature || !signature.startsWith('sha256=')) {
        return false;
    }

    const expectedSignature = signature.split('sha256=')[1];
    const hmac = crypto.createHmac('sha256', appSecret);
    hmac.update(payload, 'utf8');
    const calculatedSignature = hmac.digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(calculatedSignature, 'hex')
    );
}

/**
 * Handle webhook verification (GET request)
 * @param {object} query - Request query parameters
 * @param {string} verifyToken - Expected verify token
 * @returns {object} Verification response
 */
function handleWebhookVerification(query, verifyToken) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('[IG_WEBHOOK] Webhook verified successfully');
        return { verified: true, challenge };
    }

    console.warn('[IG_WEBHOOK] Webhook verification failed');
    return { verified: false };
}

/**
 * Check if message should be deduplicated
 * @param {number} tenantId - Tenant ID
 * @param {string} dedupKey - Deduplication key
 * @returns {Promise<boolean>} True if duplicate
 */
async function isDuplicate(tenantId, dedupKey) {
    const now = Math.floor(Date.now() / 1000);

    // Check if we've seen this event in the last 5 minutes
    const existing = await get(
        `SELECT 1 FROM ig_webhook_dedup 
     WHERE tenant_id = ? AND dedup_key = ? AND ts > ?`,
        [tenantId, dedupKey, now - 300]
    );

    if (existing) {
        return true;
    }

    // Store deduplication key
    await run(
        `INSERT INTO ig_webhook_dedup (tenant_id, dedup_key, ts) 
     VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, dedup_key) DO UPDATE SET ts = excluded.ts`,
        [tenantId, dedupKey, now]
    );

    return false;
}

/**
 * Save incoming message to database
 * @param {object} params - Message parameters
 * @returns {Promise<object>} Saved message
 */
async function saveIncomingMessage({ tenantId, threadId, fromId, text, rawJson }) {
    const ts = Math.floor(Date.now() / 1000);

    await run(
        `INSERT INTO ig_chats (tenant_id, thread_id, from_id, ts, direction, text, raw_json)
     VALUES (?, ?, ?, ?, 'in', ?, ?)`,
        [tenantId, threadId, fromId, ts, text || '', JSON.stringify(rawJson)]
    );

    // Update chat state
    await run(
        `INSERT INTO ig_chat_state (tenant_id, thread_id, is_active, updated_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(tenant_id, thread_id) DO UPDATE SET 
       is_active = 1,
       updated_at = datetime('now')`,
        [tenantId, threadId]
    );

    return { tenantId, threadId, fromId, text, ts };
}

/**
 * Save outgoing message to database
 * @param {object} params - Message parameters
 * @returns {Promise<void>}
 */
async function saveOutgoingMessage({ tenantId, threadId, text, rawJson = {} }) {
    const ts = Math.floor(Date.now() / 1000);

    await run(
        `INSERT INTO ig_chats (tenant_id, thread_id, from_id, ts, direction, text, raw_json)
     VALUES (?, ?, '', ?, 'out', ?, ?)`,
        [tenantId, threadId, ts, text || '', JSON.stringify(rawJson)]
    );
}

/**
 * Log Instagram action (for analytics and debugging)
 * @param {object} params - Action parameters
 * @returns {Promise<void>}
 */
async function logInstagramAction({
    tenantId,
    userId = 0,
    channel = '',
    targetId = '',
    incomingText = '',
    aiText = '',
    coinSpent = 0,
    status = 'ok',
    error = '',
    latencyMs = 0
}) {
    const ts = Math.floor(Date.now() / 1000);

    await run(
        `INSERT INTO ig_actions (
      tenant_id, user_id, channel, target_id, incoming_text, 
      ai_text, coin_spent, status, error, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tenantId, userId, channel, targetId, incomingText,
            aiText, coinSpent, status, error, latencyMs, ts
        ]
    );
}

/**
 * Get Instagram connection for tenant
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<object|null>} Connection data
 */
async function getInstagramConnection(tenantId) {
    return await get(
        `SELECT * FROM ig_connections WHERE tenant_id = ? AND status = 'connected'`,
        [tenantId]
    );
}

/**
 * Get Instagram settings for tenant
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<object>} Settings object
 */
async function getInstagramSettings(tenantId) {
    const settings = await get(
        `SELECT * FROM ig_settings WHERE tenant_id = ?`,
        [tenantId]
    );

    return settings || {
        dm_enabled: 1,
        comments_enabled: 1,
        mentions_enabled: 1,
        stories_enabled: 1,
        ai_enabled: 1
    };
}

/**
 * Process direct message
 * @param {object} messaging - Messaging event
 * @param {number} tenantId - Tenant ID
 * @param {object} connection - Instagram connection
 * @returns {Promise<void>}
 */
async function processDirectMessage(messaging, tenantId, connection) {
    const { sender, recipient, message, timestamp } = messaging;

    if (!message || !message.text) {
        console.log('[IG_WEBHOOK] No text in message, skipping');
        return;
    }

    const threadId = sender.id; // Use sender ID as thread ID for DMs
    const text = message.text;

    // Check for duplicates
    const dedupKey = `dm:${threadId}:${timestamp}`;
    if (await isDuplicate(tenantId, dedupKey)) {
        console.log('[IG_WEBHOOK] Duplicate message, skipping');
        return;
    }

    // Save incoming message
    await saveIncomingMessage({
        tenantId,
        threadId,
        fromId: sender.id,
        text,
        rawJson: messaging
    });

    console.log(`[IG_WEBHOOK] Saved DM from ${sender.id}: ${text.substring(0, 50)}...`);

    // Emit socket event for real-time updates
    // This will be handled by the socket.io integration
    return {
        type: 'direct_message',
        tenantId,
        threadId,
        fromId: sender.id,
        text
    };
}

/**
 * Process comment
 * @param {object} comment - Comment event
 * @param {number} tenantId - Tenant ID
 * @param {object} connection - Instagram connection
 * @returns {Promise<void>}
 */
async function processComment(comment, tenantId, connection) {
    const { id, from, text, media } = comment;

    if (!text) {
        console.log('[IG_WEBHOOK] No text in comment, skipping');
        return;
    }

    // Check for duplicates
    const dedupKey = `comment:${id}`;
    if (await isDuplicate(tenantId, dedupKey)) {
        console.log('[IG_WEBHOOK] Duplicate comment, skipping');
        return;
    }

    console.log(`[IG_WEBHOOK] Received comment ${id} from ${from?.username || from?.id}: ${text.substring(0, 50)}...`);

    // Log the event
    await run(
        `INSERT INTO ig_events (tenant_id, kind, payload, created_at)
     VALUES (?, 'comment', ?, ?)`,
        [tenantId, JSON.stringify(comment), Math.floor(Date.now() / 1000)]
    );

    return {
        type: 'comment',
        tenantId,
        commentId: id,
        fromId: from?.id,
        text,
        mediaId: media?.id
    };
}

/**
 * Process story mention
 * @param {object} mention - Mention event
 * @param {number} tenantId - Tenant ID
 * @param {object} connection - Instagram connection
 * @returns {Promise<void>}
 */
async function processStoryMention(mention, tenantId, connection) {
    const { id, from, media } = mention;

    // Check for duplicates
    const dedupKey = `mention:${id}`;
    if (await isDuplicate(tenantId, dedupKey)) {
        console.log('[IG_WEBHOOK] Duplicate mention, skipping');
        return;
    }

    console.log(`[IG_WEBHOOK] Received story mention ${id} from ${from?.username || from?.id}`);

    // Log the event
    await run(
        `INSERT INTO ig_events (tenant_id, kind, payload, created_at)
     VALUES (?, 'mention', ?, ?)`,
        [tenantId, JSON.stringify(mention), Math.floor(Date.now() / 1000)]
    );

    return {
        type: 'story_mention',
        tenantId,
        mentionId: id,
        fromId: from?.id,
        mediaId: media?.id
    };
}

/**
 * Process webhook payload
 * @param {object} body - Webhook payload
 * @returns {Promise<Array>} Processed events
 */
async function processWebhookPayload(body) {
    const events = [];

    if (!body.entry || !Array.isArray(body.entry)) {
        console.warn('[IG_WEBHOOK] No entries in webhook payload');
        return events;
    }

    for (const entry of body.entry) {
        const pageId = entry.id;

        // Find tenant by page_id
        const connection = await get(
            `SELECT * FROM ig_connections WHERE page_id = ? AND status = 'connected'`,
            [pageId]
        );

        if (!connection) {
            console.warn(`[IG_WEBHOOK] No connection found for page ${pageId}`);
            continue;
        }

        const tenantId = connection.tenant_id;
        const settings = await getInstagramSettings(tenantId);

        // Process messaging events (DMs)
        if (entry.messaging && settings.dm_enabled) {
            for (const messaging of entry.messaging) {
                try {
                    const event = await processDirectMessage(messaging, tenantId, connection);
                    if (event) events.push(event);
                } catch (error) {
                    console.error('[IG_WEBHOOK] Error processing DM:', error);
                }
            }
        }

        // Process changes (comments, mentions, etc.)
        if (entry.changes) {
            for (const change of entry.changes) {
                try {
                    const { field, value } = change;

                    if (field === 'comments' && settings.comments_enabled) {
                        const event = await processComment(value, tenantId, connection);
                        if (event) events.push(event);
                    } else if (field === 'mentions' && settings.mentions_enabled) {
                        const event = await processStoryMention(value, tenantId, connection);
                        if (event) events.push(event);
                    }
                } catch (error) {
                    console.error('[IG_WEBHOOK] Error processing change:', error);
                }
            }
        }
    }

    return events;
}

/**
 * Clean up old deduplication records (older than 1 hour)
 * Should be called periodically
 * @returns {Promise<void>}
 */
async function cleanupDedupRecords() {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    await run(
        `DELETE FROM ig_webhook_dedup WHERE ts < ?`,
        [oneHourAgo]
    );
}

module.exports = {
    verifyWebhookSignature,
    handleWebhookVerification,
    processWebhookPayload,
    saveIncomingMessage,
    saveOutgoingMessage,
    logInstagramAction,
    getInstagramConnection,
    getInstagramSettings,
    cleanupDedupRecords,
    isDuplicate
};
