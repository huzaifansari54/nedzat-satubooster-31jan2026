const express = require('express');
const router = express.Router();
const whatsapp = require('../services/whatsapp');
const instagram = require('../services/instagram');
const gupshup = require('../services/gupshup');
const db = require('../database');

// ===================================================================
// WEBHOOK ROUTES
// ===================================================================
// Handle incoming webhooks from WhatsApp, Instagram, and Gupshup

/**
 * @route GET /api/webhooks/whatsapp
 * @desc Verify WhatsApp webhook (Meta webhook verification)
 * @public
 */
router.get('/whatsapp', (req, res) => {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        const VERIFY_TOKEN = process.env.WABA_VERIFY_TOKEN || 'your-verify-token';

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('[WEBHOOK] WhatsApp webhook verified');
            res.status(200).send(challenge);
        } else {
            console.warn('[WEBHOOK] WhatsApp webhook verification failed');
            res.sendStatus(403);
        }
    } catch (err) {
        console.error('[WEBHOOK] WhatsApp verification error:', err.message);
        res.sendStatus(500);
    }
});

/**
 * @route POST /api/webhooks/whatsapp
 * @desc Handle incoming WhatsApp messages and status updates
 * @public
 */
router.post('/whatsapp', async (req, res) => {
    try {
        // Acknowledge immediately
        res.sendStatus(200);

        const body = req.body;

        // Process webhook asynchronously
        setImmediate(async () => {
            try {
                if (!body.entry || !Array.isArray(body.entry)) {
                    console.warn('[WEBHOOK] Invalid WhatsApp webhook payload');
                    return;
                }

                for (const entry of body.entry) {
                    if (!entry.changes || !Array.isArray(entry.changes)) continue;

                    for (const change of entry.changes) {
                        const value = change.value;
                        if (!value) continue;

                        // Get account by phone_number_id
                        const phoneNumberId = value.metadata?.phone_number_id;
                        if (!phoneNumberId) continue;

                        const account = await db.get(
                            `SELECT * FROM accounts WHERE waba_phone_number_id = ?`,
                            [phoneNumberId]
                        );

                        if (!account) {
                            console.warn(`[WEBHOOK] No account found for phone_number_id: ${phoneNumberId}`);
                            continue;
                        }

                        // Handle messages
                        if (value.messages && Array.isArray(value.messages)) {
                            for (const message of value.messages) {
                                try {
                                    const parsed = whatsapp.parseIncomingMessage(message, value);
                                    await whatsapp.saveIncomingMessage({
                                        tenantId: account.tenant_id,
                                        accId: account.id,
                                        ...parsed
                                    });
                                    console.log(`[WEBHOOK] WhatsApp message saved: ${message.id}`);
                                } catch (err) {
                                    console.error('[WEBHOOK] Error processing WhatsApp message:', err.message);
                                }
                            }
                        }

                        // Handle status updates
                        if (value.statuses && Array.isArray(value.statuses)) {
                            for (const status of value.statuses) {
                                try {
                                    const parsed = whatsapp.parseMessageStatus(status);
                                    await whatsapp.updateMessageStatus({
                                        tenantId: account.tenant_id,
                                        accId: account.id,
                                        ...parsed
                                    });
                                    console.log(`[WEBHOOK] WhatsApp status updated: ${status.id} -> ${status.status}`);
                                } catch (err) {
                                    console.error('[WEBHOOK] Error processing WhatsApp status:', err.message);
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[WEBHOOK] WhatsApp processing error:', err.message);
            }
        });
    } catch (err) {
        console.error('[WEBHOOK] WhatsApp webhook error:', err.message);
        res.sendStatus(500);
    }
});

/**
 * @route GET /api/webhooks/instagram
 * @desc Verify Instagram webhook
 * @public
 */
router.get('/instagram', (req, res) => {
    try {
        const result = instagram.handleWebhookVerification(req.query);

        if (result.verified) {
            res.status(200).send(result.challenge);
        } else {
            res.sendStatus(403);
        }
    } catch (err) {
        console.error('[WEBHOOK] Instagram verification error:', err.message);
        res.sendStatus(500);
    }
});

/**
 * @route POST /api/webhooks/instagram
 * @desc Handle incoming Instagram messages, comments, mentions
 * @public
 */
router.post('/instagram', async (req, res) => {
    try {
        // Verify signature
        const signature = req.headers['x-hub-signature-256'];
        const APP_SECRET = process.env.IG_APP_SECRET || process.env.FB_APP_SECRET;

        if (APP_SECRET && signature) {
            const isValid = instagram.verifyWebhookSignature(
                req.body,
                signature,
                APP_SECRET
            );

            if (!isValid) {
                console.warn('[WEBHOOK] Instagram signature verification failed');
                return res.sendStatus(403);
            }
        }

        // Acknowledge immediately
        res.sendStatus(200);

        // Process webhook asynchronously
        setImmediate(async () => {
            try {
                await instagram.processWebhookPayload(req.body);
            } catch (err) {
                console.error('[WEBHOOK] Instagram processing error:', err.message);
            }
        });
    } catch (err) {
        console.error('[WEBHOOK] Instagram webhook error:', err.message);
        res.sendStatus(500);
    }
});

/**
 * @route POST /api/webhooks/gupshup
 * @desc Handle incoming Gupshup webhooks (v3 format, Meta-compatible)
 * @public
 */
router.post('/gupshup', async (req, res) => {
    try {
        // Acknowledge immediately
        res.sendStatus(200);

        // Process webhook asynchronously
        setImmediate(async () => {
            try {
                const handleIncoming = async (message) => {
                    // Handler for incoming messages from Gupshup
                    console.log('[WEBHOOK] Gupshup incoming message:', message.id);

                    // Auto-bind phone_number_id if needed
                    await gupshup.autoBindPhoneNumberId(message);

                    // Get account by gupshup_app_id or phone_number_id
                    const phoneNumberId = message.metadata?.phone_number_id;
                    if (!phoneNumberId) {
                        console.warn('[WEBHOOK] No phone_number_id in Gupshup message');
                        return;
                    }

                    const account = await db.get(
                        `SELECT * FROM accounts WHERE waba_phone_number_id = ? OR gupshup_app_id = ?`,
                        [phoneNumberId, phoneNumberId]
                    );

                    if (!account) {
                        console.warn(`[WEBHOOK] No account found for Gupshup phone_number_id: ${phoneNumberId}`);
                        return;
                    }

                    // Save message using WhatsApp message handler (compatible format)
                    const parsed = whatsapp.parseIncomingMessage(message, message.metadata || {});
                    await whatsapp.saveIncomingMessage({
                        tenantId: account.tenant_id,
                        accId: account.id,
                        ...parsed
                    });
                };

                const handleStatus = async (status) => {
                    // Handler for status updates from Gupshup
                    console.log('[WEBHOOK] Gupshup status update:', status.id, '->', status.status);

                    // Find account by message ID
                    const message = await db.get(
                        `SELECT tenant_id, acc_id FROM chats WHERE wa_id = ?`,
                        [status.id]
                    );

                    if (!message) {
                        console.warn(`[WEBHOOK] No message found for Gupshup status: ${status.id}`);
                        return;
                    }

                    // Update status using WhatsApp status handler (compatible format)
                    const parsed = whatsapp.parseMessageStatus(status);
                    await whatsapp.updateMessageStatus({
                        tenantId: message.tenant_id,
                        accId: message.acc_id,
                        ...parsed
                    });
                };

                await gupshup.processWebhook(req.body, handleIncoming, handleStatus);
            } catch (err) {
                console.error('[WEBHOOK] Gupshup processing error:', err.message);
            }
        });
    } catch (err) {
        console.error('[WEBHOOK] Gupshup webhook error:', err.message);
        res.sendStatus(500);
    }
});

/**
 * @route POST /api/webhooks/test
 * @desc Test webhook endpoint for development/debugging
 * @public
 */
router.post('/test', (req, res) => {
    try {
        console.log('[WEBHOOK] Test webhook received:', {
            headers: req.headers,
            body: req.body,
            query: req.query
        });

        res.json({
            ok: true,
            message: 'Test webhook received',
            timestamp: new Date().toISOString(),
            receivedData: {
                headers: req.headers,
                body: req.body,
                query: req.query
            }
        });
    } catch (err) {
        console.error('[WEBHOOK] Test webhook error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
