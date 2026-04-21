// src/utils/logger.js — Professional Logging Utility
// -------------------------------------------------
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Configure pino
// In development, we use pino-pretty for readable console logs
// In production, we log as JSON for easier parsing by log managers
const transport = process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
        }
    }
    : {
        targets: [
            {
                target: 'pino/file',
                options: { destination: path.join(logDir, 'app.log') },
                level: 'info'
            },
            {
                target: 'pino/file',
                options: { destination: path.join(logDir, 'error.log') },
                level: 'error'
            }
        ]
    };

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: {
        env: process.env.NODE_ENV || 'development'
    },
    timestamp: pino.stdTimeFunctions.isoTime
}, pino.transport(transport));

module.exports = logger;
