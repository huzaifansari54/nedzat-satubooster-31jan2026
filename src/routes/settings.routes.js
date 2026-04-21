const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');
const { logger } = require('../utils');

/**
 * @route GET /api/settings
 * @desc Get all settings for the current tenant
 */
router.get('/', authGuard, async (req, res) => {
    try {
        const rows = await db.all(
            `SELECT  key, value FROM settings WHERE tenant_id=?`,
            [req.user.tenant_id]
        );

        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }

        res.json({ ok: true, settings });
    } catch (err) {
        logger.error({ err }, '[SETTINGS] GET error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/settings/:key
 * @desc Get a specific setting value
 */
router.get('/:key', authGuard, async (req, res) => {
    try {
        const { key } = req.params;
        const row = await db.get(
            `SELECT value FROM settings WHERE tenant_id=? AND key=?`,
            [req.user.tenant_id, key]
        );

        res.json({
            ok: true,
            key,
            value: row ? row.value : null
        });
    } catch (err) {
        logger.error({ err, key: req.params.key }, '[SETTINGS] GET key error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/settings
 * @desc Update multiple settings at once
 */
router.post('/', authGuard, async (req, res) => {
    try {
        const { settings } = req.body || {};
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ ok: false, error: 'settings object required' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await db.run(
                `INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
                 ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value`,
                [req.user.tenant_id, key, String(value)]
            );
        }

        res.json({ ok: true });
    } catch (err) {
        logger.error({ err }, '[SETTINGS] POST error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/settings/:key
 * @desc Update a specific setting
 */
router.put('/:key', authGuard, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body || {};

        if (value === undefined || value === null) {
            return res.status(400).json({ ok: false, error: 'value required' });
        }

        await db.run(
            `INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
             ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value`,
            [req.user.tenant_id, key, String(value)]
        );

        res.json({ ok: true, key, value });
    } catch (err) {
        logger.error({ err, key: req.params.key }, '[SETTINGS] PUT error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/settings/:key
 * @desc Delete a specific setting
 */
router.delete('/:key', authGuard, adminOnly, async (req, res) => {
    try {
        const { key } = req.params;

        await db.run(
            `DELETE FROM settings WHERE tenant_id=? AND key=?`,
            [req.user.tenant_id, key]
        );

        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, key: req.params.key }, '[SETTINGS] DELETE error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/settings/global/:key
 * @desc Get a global setting (tenant_id=1)
 */
router.get('/global/:key', authGuard, adminOnly, async (req, res) => {
    try {
        const { key } = req.params;
        const row = await db.get(
            `SELECT value FROM settings WHERE tenant_id=1 AND key=?`,
            [key]
        );

        res.json({
            ok: true,
            key,
            value: row ? row.value : null
        });
    } catch (err) {
        logger.error({ err, key: req.params.key }, '[SETTINGS] GET global error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/settings/global/:key
 * @desc Update a global setting (tenant_id=1, admin only)
 */
router.put('/global/:key', authGuard, adminOnly, async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body || {};

        if (value === undefined || value === null) {
            return res.status(400).json({ ok: false, error: 'value required' });
        }

        await db.run(
            `INSERT INTO settings(tenant_id, key, value) VALUES(1, ?, ?)
             ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value`,
            [key, String(value)]
        );

        res.json({ ok: true, key, value });
    } catch (err) {
        logger.error({ err, key: req.params.key }, '[SETTINGS] PUT global error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
