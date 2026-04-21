// src/sockets/index.js — Socket.IO Setup
// -------------------------------------------------
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getCorsOrigins } = require('../config/cors');
const { logger } = require('../utils');

// Import socket handlers
const chatSocket = require('./chat.socket');
const campaignSocket = require('./campaign.socket');
const notificationSocket = require('./notification.socket');

let io = null;

/**
 * Setup Socket.IO server
 */
function setupSocketIO(server) {
    io = new Server(server, {
        cors: {
            origin: getCorsOrigins(),
            credentials: true
        }
    });

    // Authentication middleware
    io.use((socket, next) => {
        try {
            // Check auth token in handshake (auth object, headers, or cookies)
            let tok = socket.handshake.auth?.token ||
                socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

            if (!tok) {
                const cookie = socket.request.headers.cookie || '';
                // Simple regex to extract token from cookie string
                const match = cookie.match(/(?:^|.*;\s*)token\s*=\s*([^;]*).*$/);
                if (match) tok = match[1];
            }

            if (!tok) {
                return next(new Error('unauthorized'));
            }

            const decoded = jwt.verify(tok, config.jwtSecret);
            socket.user = {
                id: decoded.uid,
                tenant_id: decoded.tid,
                role: decoded.role,
                email: decoded.email
            };

            next();
        } catch (err) {
            logger.error({ err, handshake: socket.handshake }, '[SOCKET] Auth error');
            next(new Error('unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        const tid = socket.user.tenant_id;
        const uid = socket.user.id;

        logger.info({ socketId: socket.id, uid, tid }, '[SOCKET] Client connected');

        // Join tenant and user rooms for targeted broadcasts
        socket.join(`tenant_${tid}`);
        socket.join(`user_${uid}`);

        // Setup modular socket event handlers
        chatSocket(io, socket);
        campaignSocket(io, socket);
        notificationSocket(io, socket);

        socket.on('disconnect', () => {
            logger.info({ socketId: socket.id, uid, tid }, '[SOCKET] Client disconnected');
        });
    });

    return io;
}

/**
 * Get Socket.IO instance
 */
function getIO() {
    if (!io) {
        throw new Error('Socket.IO not initialized. Call setupSocketIO or setIO first.');
    }
    return io;
}

/**
 * Manually set Socket.IO instance (for legacy bridge)
 */
function setIO(instance) {
    io = instance;
    return io;
}

module.exports = {
    setupSocketIO,
    getIO,
    setIO
};
