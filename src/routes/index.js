// src/routes/index.js — Main API Router
// -------------------------------------------------
const express = require('express');
const router = express.Router();

// TODO: Import route modules as they are created
// const authRoutes = require('./auth.routes');
// const usersRoutes = require('./users.routes');
// const tenantsRoutes = require('./tenants.routes');
// const accountsRoutes = require('./accounts.routes');
// const contactsRoutes = require('./contacts.routes');
// const messagesRoutes = require('./messages.routes');
// const campaignsRoutes = require('./campaigns.routes');
// const knowledgeRoutes = require('./knowledge.routes');
// const aiRoutes = require('./ai.routes');
// const analyticsRoutes = require('./analytics.routes');
// const satuCoinRoutes = require('./satu-coin.routes');
// const settingsRoutes = require('./settings.routes');
// const webhooksRoutes = require('./webhooks.routes');
// const adminRoutes = require('./admin.routes');

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        ok: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// TODO: Mount route modules
// router.use('/auth', authRoutes);
// router.use('/users', usersRoutes);
// router.use('/tenants', tenantsRoutes);
// router.use('/accounts', accountsRoutes);
// router.use('/contacts', contactsRoutes);
// router.use('/messages', messagesRoutes);
// router.use('/campaigns', campaignsRoutes);
// router.use('/knowledge', knowledgeRoutes);
// router.use('/ai', aiRoutes);
// router.use('/analytics', analyticsRoutes);
// router.use('/satu', satuCoinRoutes);
// router.use('/settings', settingsRoutes);
// router.use('/webhooks', webhooksRoutes);
// router.use('/admin', adminRoutes);

module.exports = router;
