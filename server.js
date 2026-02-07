// server.js — NeDzat SaaS Entry Point
// -------------------------------------------------
require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const { setupSocketIO } = require('./src/sockets');

const PORT = process.env.PORT || 3099;
const server = http.createServer(app);

// Setup Socket.IO
setupSocketIO(server);

// Start server
server.listen(PORT, () => {
    console.log(`🚀 NeDzat SaaS running on port ${PORT}`);
    console.log(`📍 Public URL: ${process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// Error handlers
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED REJECTION]', error?.stack || error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error?.stack || error);
    setTimeout(() => process.exit(1), 500);
});
