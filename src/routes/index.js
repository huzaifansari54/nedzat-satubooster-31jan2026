// src/routes/index.js — Main API Router
// -------------------------------------------------
const express = require('express');
const router = express.Router();

// TODO: Import route modules as they are created
const authRoutes = require('./auth.routes');
const usersRoutes = require('./users.routes');
const notificationsRoutes = require('./notifications.routes');
const settingsRoutes = require('./settings.routes');
const apiKeysRoutes = require('./apikeys.routes');
const accountsRoutes = require('./accounts.routes');
const tenantsRoutes = require('./tenants.routes');
const contactsRoutes = require('./contacts.routes');
const messagesRoutes = require('./messages.routes');
const knowledgeRoutes = require('./knowledge.routes');
const aiRoutes = require('./ai.routes');

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        ok: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Mount route modules
router.use('/auth', authRoutes);
router.use('/notify', notificationsRoutes);
router.use('/settings', settingsRoutes);
router.use('/apikeys', apiKeysRoutes);
router.use('/accounts', accountsRoutes);
router.use('/tenants', tenantsRoutes);
router.use('/contacts', contactsRoutes);
router.use('/messages', messagesRoutes);
router.use('/knowledge', knowledgeRoutes);
router.use('/ai', aiRoutes);
router.use('/', usersRoutes); // Mounts /me, /profile, etc. at root of API

module.exports = router;
