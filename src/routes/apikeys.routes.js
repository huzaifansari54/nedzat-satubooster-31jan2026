const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');
const crypto = require('crypto');
const { logger } = require('../utils');

/**
 * Generate a secure API key
 * @returns {string} API key with 'nk_' prefix
 */
function generateApiKey() {
    return 'nk_' + crypto.randomBytes(32).toString('hex');
}

/**
 * @route GET /api/apikeys
 * @desc Get all API keys for the current tenant
 */
router.get('/', authGuard, async (req, res) => {
    try {
        const keys = await db.all(
            `SELECT id, label, key, created_at, last_used_at 
             FROM api_keys 
             WHERE tenant_id=? 
             ORDER BY created_at DESC`,
            [req.user.tenant_id]
        );

        res.json({ ok: true, keys });
    } catch (err) {
        logger.error({ err }, '[APIKEYS] GET error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/apikeys
 * @desc Create a new API key
 */
router.post('/', authGuard, async (req, res) => {
    try {
        const { label } = req.body || {};
        const key = generateApiKey();

        const result = await db.run(
            `INSERT INTO api_keys(tenant_id, label, key, created_at) 
             VALUES(?, ?, ?, ?)`,
            [req.user.tenant_id, label || '', key, Date.now()]
        );

        res.json({
            ok: true,
            key,
            id: result.lastID,
            label: label || ''
        });
    } catch (err) {
        logger.error({ err }, '[APIKEYS] POST error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/apikeys/:id
 * @desc Update API key label
 */
router.put('/:id', authGuard, async (req, res) => {
    try {
        const { id } = req.params;
        const { label } = req.body || {};

        if (!label) {
            return res.status(400).json({ ok: false, error: 'label required' });
        }

        // Verify ownership
        const existing = await db.get(
            `SELECT id FROM api_keys WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'API key not found' });
        }

        await db.run(
            `UPDATE api_keys SET label=? WHERE id=? AND tenant_id=?`,
            [label, id, req.user.tenant_id]
        );

        res.json({ ok: true, id, label });
    } catch (err) {
        logger.error({ err, keyId: req.params.id }, '[APIKEYS] PUT error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/apikeys/:id
 * @desc Delete an API key
 */
router.delete('/:id', authGuard, async (req, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const existing = await db.get(
            `SELECT id FROM api_keys WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'API key not found' });
        }

        await db.run(
            `DELETE FROM api_keys WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, keyId: req.params.id }, '[APIKEYS] DELETE error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/apikeys/:id/regenerate
 * @desc Regenerate an API key (creates new key, invalidates old one)
 */
router.post('/:id/regenerate', authGuard, async (req, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const existing = await db.get(
            `SELECT id, label FROM api_keys WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'API key not found' });
        }

        const newKey = generateApiKey();

        await db.run(
            `UPDATE api_keys SET key=?, created_at=?, last_used_at=NULL WHERE id=? AND tenant_id=?`,
            [newKey, Date.now(), id, req.user.tenant_id]
        );

        res.json({
            ok: true,
            key: newKey,
            id,
            label: existing.label
        });
    } catch (err) {
        logger.error({ err, keyId: req.params.id }, '[APIKEYS] REGENERATE error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
