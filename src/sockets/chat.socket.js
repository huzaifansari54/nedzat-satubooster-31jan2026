// src/sockets/chat.socket.js — Chat Socket Handlers
// -------------------------------------------------
const db = require('../database');

/**
 * Handle chat-related socket events
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
module.exports = async function chatSocket(io, socket) {
    const tid = socket.user.tenant_id;

    // Send account list on connection (extracted from index.js)
    try {
        const accounts = await listAccountsByTenant(tid);
        socket.emit('acc:list', accounts);
    } catch (err) {
        console.error('[SOCKET][CHAT] Failed to send acc:list:', err.message);
    }

    // In the future, add more chat-specific events here
    // socket.on('chat:join', (data) => { ... });
    // socket.on('chat:typing', (data) => { ... });
};

/**
 * Helper to list accounts by tenant
 * (Extracted from index.js:6324)
 */
async function listAccountsByTenant(tid) {
    return await db.all(
        `SELECT id, label, folder, me_jid, status, model, temperature, max_tokens, forced_lang, ai_enabled, kind, tg_username
         FROM accounts 
         WHERE tenant_id=? AND COALESCE(status,'')!='merged' 
         ORDER BY id`,
        [tid]
    );
}
