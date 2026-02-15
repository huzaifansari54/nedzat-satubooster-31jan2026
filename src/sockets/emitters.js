// src/sockets/emitters.js — Shared Socket Emitters
// -------------------------------------------------
const { getIO } = require('./index');

/**
 * Emit 'newchat' event to a tenant
 */
function emitNewChat(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('newchat', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] newchat failed:', err.message);
    }
}

/**
 * Emit 'reaction:update' event to a tenant
 */
function emitReactionUpdate(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('reaction:update', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] reaction:update failed:', err.message);
    }
}

/**
 * Emit 'acc:status' update
 */
function emitAccountStatus(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('acc:status', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] acc:status failed:', err.message);
    }
}

/**
 * Emit 'acc:update' update
 */
function emitAccountUpdate(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('acc:update', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] acc:update failed:', err.message);
    }
}

/**
 * Emit 'acc:list' update (broadcast list of accounts)
 */
function emitAccountList(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('acc:list', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] acc:list failed:', err.message);
    }
}

/**
 * Emit 'acc:qr' update
 */
function emitAccountQR(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('acc:qr', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] acc:qr failed:', err.message);
    }
}

/**
 * Emit 'ui:typing' status
 */
function emitTypingStatus(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('ui:typing', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] ui:typing failed:', err.message);
    }
}

/**
 * Emit notification to a specific user
 */
function emitUserNotification(userId, data) {
    try {
        const io = getIO();
        io.to(`user_${userId}`).emit('notification', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] user notification failed:', err.message);
    }
}

/**
 * Emit legacy 'notify:admin' to a specific user
 */
function emitAdminNotification(userId, data) {
    try {
        const io = getIO();
        io.to(`user_${userId}`).emit('notify:admin', data);
    } catch (err) {
        console.error('[SOCKET][EMIT] admin notification failed:', err.message);
    }
}

module.exports = {
    emitNewChat,
    emitReactionUpdate,
    emitAccountStatus,
    emitAccountUpdate,
    emitAccountList,
    emitAccountQR,
    emitTypingStatus,
    emitUserNotification,
    emitAdminNotification
};
