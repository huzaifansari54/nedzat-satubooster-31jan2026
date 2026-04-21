// src/services/whatsapp/baileys-handler.js
// -------------------------------------------------

const db = require('../../database');
const { logger } = require('../../utils');
const { jidToPhone, normalizeMeJid } = require('./helpers');
const crypto = require('crypto');
const emitters = require('../../sockets/emitters');

/**
 * Handle incoming messages from Baileys
 */
async function handleMessages(accId, messages, sock, tenantId) {
    for (const msg of messages) {
        try {
            if (!msg.message) continue;

            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;

            const fromMe = !!msg.key.fromMe;
            const messageId = msg.key.id;
            const timestamp = msg.messageTimestamp;

            // Extract text
            const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                '';

            // Extract media info if any
            let mediaFile = '';
            let mediaKind = '';
            if (msg.message.imageMessage) mediaKind = 'image';
            else if (msg.message.videoMessage) mediaKind = 'video';
            else if (msg.message.audioMessage) mediaKind = 'audio';
            else if (msg.message.documentMessage) mediaKind = 'document';

            // Duplicate check
            const existing = await db.get('SELECT id FROM chats WHERE wa_id = ? AND acc_id = ?', [messageId, accId]);
            if (existing) continue;

            const ts = Number(timestamp);
            const date = new Date(ts * 1000).toISOString().slice(0, 10);
            const extId = crypto.randomUUID();

            // Save to DB
            await db.run(
                `INSERT INTO chats(tenant_id, jid, date, ts, message, type, acc_id, media_file, media_kind, crm_ext_id, wa_id)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId, jid, date, ts, text, fromMe ? 'out' : 'in', accId,
                    mediaFile, mediaKind, extId, messageId
                ]
            );

            // Emit to sockets
            emitters.emitNewChat(tenantId, {
                acc_id: accId,
                jid: jid,
                phone: jidToPhone(jid),
                type: fromMe ? 'out' : 'in',
                ts,
                text,
                media_file: mediaFile,
                media_kind: mediaKind,
                date
            });

            logger.info({ accId, jid, fromMe }, '[BAILEYS] Message processed');

        } catch (err) {
            logger.error({ err, accId }, '[BAILEYS] Failed to handle message');
        }
    }
}

module.exports = {
    handleMessages
};
