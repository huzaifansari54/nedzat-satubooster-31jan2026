// src/sockets/index.js — Socket.IO Setup
// -------------------------------------------------
const { Server } = require('socket.io');
const { getCorsOrigins } = require('../config/cors');

// TODO: Import socket handlers as they are created
// const chatSocket = require('./chat.socket');
// const campaignSocket = require('./campaign.socket');
// const notificationSocket = require('./notification.socket');

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

    io.on('connection', (socket) => {
        console.log(`[SOCKET] Client connected: ${socket.id}`);

        // TODO: Setup socket event handlers
        // chatSocket(io, socket);
        // campaignSocket(io, socket);
        // notificationSocket(io, socket);

        socket.on('disconnect', () => {
            console.log(`[SOCKET] Client disconnected: ${socket.id}`);
        });
    });

    return io;
}

/**
 * Get Socket.IO instance
 */
function getIO() {
    if (!io) {
        throw new Error('Socket.IO not initialized. Call setupSocketIO first.');
    }
    return io;
}

module.exports = {
    setupSocketIO,
    getIO
};
