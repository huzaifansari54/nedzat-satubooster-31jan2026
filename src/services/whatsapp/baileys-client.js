// src/services/whatsapp/baileys-client.js
// -------------------------------------------------

const pino = require('pino');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const db = require('../../database');
const emitters = require('../../sockets/emitters');
const { logger } = require('../../utils');
const { normalizeMeJid, normalizeDirectJid } = require('./helpers');
const baileysHandler = require('./baileys-handler');

/**
 * Dynamic import helper for Baileys (ESM)
 */
async function loadBaileys() {
    return await import('@whiskeysockets/baileys');
}

// Active sockets map: accId -> { sock, stopping, tenantId, presenceInterval, msgRetryCounterMap }
const sockets = new Map();
const startingAccounts = new Set();
const lastQRMap = new Map();
const reconnectAttempts = new Map();

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 300000;

/**
 * Update account status in DB and emit to sockets
 */
async function setAccStatus(accId, status, me_jid = null) {
    try {
        const account = await db.get('SELECT id, tenant_id FROM accounts WHERE id=?', [accId]);
        if (!account) return;

        const tenantId = account.tenant_id;
        const normMe = me_jid ? normalizeMeJid(me_jid) : null;

        await db.run(
            `UPDATE accounts SET status=?, me_jid=COALESCE(?, me_jid), updated_at=? WHERE id=?`,
            [status, normMe, Date.now(), accId]
        );

        emitters.emitAccountUpdate(tenantId, { id: accId, status, me_jid: normMe || undefined });
    } catch (err) {
        logger.error({ err, accId }, '[BAILEYS] setAccStatus failed');
    }
}

/**
 * Start Baileys socket for a WhatsApp account
 */
async function startAccount(accId) {
    if (startingAccounts.has(accId)) return;
    startingAccounts.add(accId);

    try {
        if (sockets.get(accId)?.sock) return;

        const acc = await db.get('SELECT * FROM accounts WHERE id=?', [accId]);
        if (!acc) throw new Error('Account not found');

        const tenantId = Number(acc.tenant_id || 1);
        const kind = String(acc.kind || 'wa').toLowerCase();

        // Skip if not WhatsApp or WABA enabled
        if (kind !== 'wa' || acc.waba_enabled === 1) {
            startingAccounts.delete(accId);
            return;
        }

        const {
            default: makeWASocket,
            useMultiFileAuthState,
            fetchLatestBaileysVersion,
            DisconnectReason
        } = await loadBaileys();

        const { version } = await fetchLatestBaileysVersion();
        logger.info({ accId, version }, '[BAILEYS] Starting account');

        const folder = path.join(process.cwd(), 'auth', `acc-${accId}`);
        await fsp.mkdir(folder, { recursive: true });

        // Update folder and engine in DB if needed
        if (!acc.folder || acc.folder !== folder || acc.wa_engine !== 'baileys') {
            await db.run(
                `UPDATE accounts SET folder=?, wa_engine='baileys', updated_at=? WHERE id=?`,
                [folder, Date.now(), accId]
            );
        }

        const { state, saveCreds } = await useMultiFileAuthState(folder);

        // Load retry counters
        let msgRetryCounterMap = {};
        try {
            const retryPath = path.join(folder, 'msg-retry-counter.json');
            const retryData = await fsp.readFile(retryPath, 'utf8');
            msgRetryCounterMap = JSON.parse(retryData);
        } catch (e) {
            msgRetryCounterMap = {};
        }

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            syncFullHistory: false,
            fireInitQueries: true,
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 120000,
            retryRequestDelayMs: 5000,
            keepAliveIntervalMs: 25000,
            msgRetryCounterMap,
            maxMsgRetryCount: 5,
            ignoreOldMessages: true,
            getMessage: async (key) => {
                try {
                    const id = key?.id;
                    if (!id) return undefined;

                    const row = await db.get(
                        'SELECT message, media_kind FROM chats WHERE acc_id=? AND wa_id=? LIMIT 1',
                        [accId, id]
                    );

                    if (!row) return undefined;

                    const text = row.message || '';

                    if (row.media_kind === 'image') return { imageMessage: { caption: text } };
                    if (row.media_kind === 'video') return { videoMessage: { caption: text } };
                    if (row.media_kind === 'audio') return { audioMessage: {} };
                    if (row.media_kind === 'document') return { documentMessage: { caption: text } };

                    return { conversation: text };
                } catch (e) {
                    return undefined;
                }
            }
        });

        sockets.set(accId, { sock, stopping: false, tenantId, msgRetryCounterMap });

        // Event: Creds Update
        sock.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const retryPath = path.join(folder, 'msg-retry-counter.json');
                await fsp.writeFile(retryPath, JSON.stringify(msgRetryCounterMap, null, 2));
            } catch (e) { }
        });

        // Event: Connection Update
        sock.ev.on('connection.update', async (upd) => {
            const { connection, lastDisconnect, qr } = upd;

            if (qr) {
                const registered = !!(state?.creds?.registered);
                if (!registered) {
                    lastQRMap.set(accId, qr);
                    emitters.emitAccountQR(tenantId, { id: accId, qr });
                    await setAccStatus(accId, 'qr');
                }
            }

            if (connection === 'open') {
                lastQRMap.delete(accId);
                reconnectAttempts.delete(accId);
                const me = state?.creds?.me?.id || null;
                await setAccStatus(accId, 'online', me);

                // Close QR popup
                emitters.emitAccountQR(tenantId, { id: accId, qr: null });

                // Presence interval
                const presenceInterval = setInterval(async () => {
                    const current = sockets.get(accId);
                    if (!current || current.stopping) {
                        clearInterval(presenceInterval);
                        return;
                    }
                    try { await sock.sendPresenceUpdate('available'); } catch (e) {
                        clearInterval(presenceInterval);
                    }
                }, 60000);

                const rec = sockets.get(accId);
                if (rec) rec.presenceInterval = presenceInterval;

                try { await sock.sendPresenceUpdate('available'); } catch (_) { }
                logger.info({ accId }, '[BAILEYS] Connected successfully');
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const rec = sockets.get(accId);
                const stopping = rec?.stopping;

                if (code === DisconnectReason.restartRequired) {
                    logger.info({ accId }, '[BAILEYS] Restart required');
                    if (rec?.presenceInterval) clearInterval(rec.presenceInterval);
                    sockets.delete(accId);
                    setTimeout(() => startAccount(accId), 2000);
                    return;
                }

                if (code === DisconnectReason.loggedOut || code === 401) {
                    logger.warn({ accId }, '[BAILEYS] Logged out');
                    await logoutAccount(accId);
                    return;
                }

                sockets.delete(accId);
                if (rec?.presenceInterval) clearInterval(rec.presenceInterval);

                if (!stopping) {
                    let attempts = reconnectAttempts.get(accId) || { count: 0 };
                    attempts.count++;
                    reconnectAttempts.set(accId, attempts);

                    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempts.count - 1), MAX_RECONNECT_DELAY);
                    logger.error({ accId, attempt: attempts.count, delay }, '[BAILEYS] Connection closed, reconnecting...');

                    setTimeout(() => startAccount(accId), delay);
                }

                await setAccStatus(accId, 'offline');
            }
        });

        // Event: Messages Upsert
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            await baileysHandler.handleMessages(accId, m.messages, sock, tenantId);
        });

    } catch (err) {
        logger.error({ err, accId }, '[BAILEYS] Start account failed');
    } finally {
        startingAccounts.delete(accId);
    }
}

/**
 * Stop an account's Baileys process
 */
async function stopAccount(accId) {
    const rec = sockets.get(accId);
    if (rec) {
        rec.stopping = true;
        if (rec.presenceInterval) clearInterval(rec.presenceInterval);
        try { rec.sock.end(); } catch (_) { }
        sockets.delete(accId);
    }
    await setAccStatus(accId, 'offline');
}

/**
 * Logout and cleanup an account
 */
async function logoutAccount(accId) {
    const rec = sockets.get(accId);
    if (rec?.sock) {
        rec.stopping = true;
        try { await rec.sock.logout(); } catch (_) { }
        try { rec.sock.end(); } catch (_) { }
    }
    sockets.delete(accId);
    reconnectAttempts.delete(accId);
    lastQRMap.delete(accId);

    const acc = await db.get('SELECT folder FROM accounts WHERE id=?', [accId]);
    if (acc?.folder) {
        try { await fsp.rm(acc.folder, { recursive: true, force: true }); } catch (_) { }
    }
    await setAccStatus(accId, 'qr'); // Set to QR status for reconnection
}

/**
 * Get active socket for an account
 */
function getSocket(accId) {
    return sockets.get(accId)?.sock;
}

module.exports = {
    startAccount,
    stopAccount,
    logoutAccount,
    getSocket,
    setAccStatus
};
