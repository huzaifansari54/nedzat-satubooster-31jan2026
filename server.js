// server.js — NeDzat SaaS Entry Point
// -------------------------------------------------
require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const { setupSocketIO } = require('./src/sockets');
const { logger } = require('./src/utils');

const PORT = process.env.PORT || 3099;
const server = http.createServer(app);

// Setup Socket.IO
setupSocketIO(server);

// Start server
server.listen(PORT, async () => {
    logger.info({
        port: PORT,
        url: process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`,
        env: process.env.NODE_ENV || 'development'
    }, '🚀 NeDzat SaaS running');

    // Start active WhatsApp accounts
    try {
        const { startAccount } = require('./src/services/whatsapp');
        const db = require('./src/database');

        const accounts = await db.all("SELECT id FROM accounts WHERE status='online' AND kind='wa'");
        logger.info({ count: accounts.length }, '📦 Starting active WhatsApp accounts');

        for (const acc of accounts) {
            try {
                await startAccount(acc.id);
            } catch (err) {
                logger.error({ err, accId: acc.id }, '❌ Failed to start account');
            }
        }
    } catch (err) {
        logger.error(err, '❌ Initial account startup failed');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT signal received: closing HTTP server');
    server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });
});

// Error handlers
process.on('unhandledRejection', (error) => {
    logger.error(error, '[UNHANDLED REJECTION]');
});

process.on('uncaughtException', (error) => {
    logger.error(error, '[UNCAUGHT EXCEPTION]');
    setTimeout(() => process.exit(1), 500);
});
