/**
 * Gupshup Webhook Handler
 * Processes incoming webhooks from Gupshup (v3 format, Meta-compatible)
 */

const { get, run } = require('../../database');

/**
 * Process Gupshup webhook payload
 * Handles incoming messages and status updates
 * Auto-binds phone_number_id to gupshup_app_id when available
 * 
 * @param {object} body - Webhook payload
 * @param {Function} handleWABAIncoming - Message handler function
 * @param {Function} handleWABAStatus - Status handler function
 * @returns {Promise<void>}
 */
async function processWebhook(body, handleWABAIncoming, handleWABAStatus) {
    if (body?.object !== 'whatsapp_business_account') {
        console.log('[GUPSHUP][WEBHOOK] Ignoring non-WhatsApp webhook');
        return;
    }

    for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
            if (change.field === 'messages') {
                const value = change.value;

                // Auto-bind phone_number_id to gupshup_app_id (if provided)
                await autoBindPhoneNumberId(value, body);

                // Process incoming messages
                for (const message of value.messages || []) {
                    try {
                        await handleWABAIncoming(message, value.metadata);
                    } catch (err) {
                        console.error('[GUPSHUP][WEBHOOK] Handle message error:', err);
                    }
                }

                // Process status updates
                for (const status of value.statuses || []) {
                    try {
                        await handleWABAStatus(status);
                    } catch (err) {
                        console.error('[GUPSHUP][WEBHOOK] Handle status error:', err);
                    }
                }
            }
        }
    }
}

/**
 * Auto-bind phone_number_id to gupshup_app_id
 * This allows automatic linking when the first message arrives
 * 
 * @param {object} value - Webhook value object
 * @param {object} body - Full webhook body
 * @returns {Promise<void>}
 */
async function autoBindPhoneNumberId(value, body) {
    const phoneNumberId = value?.metadata?.phone_number_id;
    const gupshupAppId = body?.gs_app_id;

    if (!phoneNumberId || !gupshupAppId) {
        return;
    }

    try {
        // Find account with this gupshup_app_id but no phone_number_id set
        const account = await get(
            `SELECT id FROM accounts
       WHERE waba_provider='gupshup' 
       AND gupshup_app_id=? 
       AND (waba_phone_number_id IS NULL OR waba_phone_number_id='')`,
            [String(gupshupAppId)]
        );

        if (account?.id) {
            await run(
                `UPDATE accounts SET waba_phone_number_id=? WHERE id=?`,
                [String(phoneNumberId), account.id]
            );
            console.log(`[GUPSHUP][WEBHOOK] Auto-bound phone_number_id ${phoneNumberId} to account ${account.id}`);
        }
    } catch (err) {
        console.error('[GUPSHUP][WEBHOOK] Auto-bind error:', err);
    }
}

module.exports = {
    processWebhook,
    autoBindPhoneNumberId
};
