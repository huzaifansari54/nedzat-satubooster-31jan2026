// src/sockets/emitters.js — Shared Socket Emitters
// -------------------------------------------------
const { getIO } = require('./index');
const { logger } = require('../utils');

/**
 * Emit 'newchat' event to a tenant
 */
function emitNewChat(tenantId, data) {
    try {
        const io = getIO();
        io.to(`tenant_${tenantId}`).emit('newchat', data);
    } catch (err) {
        logger.error({ err, tenantId }, '[SOCKET][EMIT] newchat failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] reaction:update failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] acc:status failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] acc:update failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] acc:list failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] acc:qr failed');
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
        logger.error({ err, tenantId }, '[SOCKET][EMIT] ui:typing failed');
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
        logger.error({ err, userId }, '[SOCKET][EMIT] user notification failed');
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
        logger.error({ err, userId }, '[SOCKET][EMIT] admin notification failed');
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
