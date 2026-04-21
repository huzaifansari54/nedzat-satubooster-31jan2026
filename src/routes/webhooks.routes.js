const express = require('express');
const router = express.Router();
const whatsapp = require('../services/whatsapp');
const instagram = require('../services/instagram');
const gupshup = require('../services/gupshup');
const db = require('../database');
const { logger } = require('../utils');

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
            logger.info('[WEBHOOK] WhatsApp webhook verified');
            res.status(200).send(challenge);
        } else {
            logger.warn({ mode, token }, '[WEBHOOK] WhatsApp webhook verification failed');
            res.sendStatus(403);
        }
    } catch (err) {
        logger.error({ err }, '[WEBHOOK] WhatsApp verification error');
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
                    logger.warn({ body }, '[WEBHOOK] Invalid WhatsApp webhook payload');
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
                            logger.warn({ phoneNumberId }, '[WEBHOOK] No account found for WABA phone_number_id');
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
                                    logger.info({ messageId: message.id, accId: account.id }, '[WEBHOOK] WhatsApp message processed');
                                } catch (err) {
                                    logger.error({ err, messageId: message.id }, '[WEBHOOK] Error processing WhatsApp message');
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
                                    logger.info({ statusId: status.id, status: status.status }, '[WEBHOOK] WhatsApp status updated');
                                } catch (err) {
                                    logger.error({ err, statusId: status.id }, '[WEBHOOK] Error processing WhatsApp status update');
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                logger.error({ err }, '[WEBHOOK] WhatsApp async processing exception');
            }
        });
    } catch (err) {
        logger.error({ err }, '[WEBHOOK] WhatsApp webhook entry error');
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
            logger.info('[WEBHOOK] Instagram webhook verified');
            res.status(200).send(result.challenge);
        } else {
            logger.warn({ query: req.query }, '[WEBHOOK] Instagram verification failed');
            res.sendStatus(403);
        }
    } catch (err) {
        logger.error({ err }, '[WEBHOOK] Instagram verification exception');
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
                logger.warn({ signature }, '[WEBHOOK] Instagram signature verification failed');
                return res.sendStatus(403);
            }
        }

        // Acknowledge immediately
        res.sendStatus(200);

        // Process webhook asynchronously
        setImmediate(async () => {
            try {
                await instagram.processWebhookPayload(req.body);
                logger.debug('[WEBHOOK] Instagram payload processed');
            } catch (err) {
                logger.error({ err }, '[WEBHOOK] Instagram payload processing exception');
            }
        });
    } catch (err) {
        logger.error({ err }, '[WEBHOOK] Instagram webhook outer exception');
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
                    logger.info({ messageId: message.id }, '[WEBHOOK] Gupshup incoming message');

                    // Auto-bind phone_number_id if needed
                    await gupshup.autoBindPhoneNumberId(message);

                    // Get account by gupshup_app_id or phone_number_id
                    const phoneNumberId = message.metadata?.phone_number_id;
                    if (!phoneNumberId) {
                        logger.warn({ messageId: message.id }, '[WEBHOOK] No phone_number_id in Gupshup message');
                        return;
                    }

                    const account = await db.get(
                        `SELECT * FROM accounts WHERE waba_phone_number_id = ? OR gupshup_app_id = ?`,
                        [phoneNumberId, phoneNumberId]
                    );

                    if (!account) {
                        logger.warn({ phoneNumberId }, '[WEBHOOK] No account found for Gupshup phone_number_id');
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
                    logger.info({ statusId: status.id, status: status.status }, '[WEBHOOK] Gupshup status update');

                    // Find account by message ID
                    const message = await db.get(
                        `SELECT tenant_id, acc_id FROM chats WHERE wa_id = ?`,
                        [status.id]
                    );

                    if (!message) {
                        logger.warn({ statusId: status.id }, '[WEBHOOK] No message record found for Gupshup status update');
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
                logger.error({ err }, '[WEBHOOK] Gupshup async process exception');
            }
        });
    } catch (err) {
        logger.error({ err }, '[WEBHOOK] Gupshup webhook entry exception');
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
        logger.info({
            headers: req.headers,
            body: req.body,
            query: req.query
        }, '[WEBHOOK] Test webhook received');

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
        logger.error({ err }, '[WEBHOOK] Test webhook exception');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
