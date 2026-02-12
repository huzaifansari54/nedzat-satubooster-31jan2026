const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');

/**
 * @route GET /api/accounts
 * @desc Get all messaging accounts for the current tenant (WhatsApp, Telegram, Instagram)
 */
router.get('/', authGuard, async (req, res) => {
    try {
        const accounts = await db.all(
            `SELECT 
                id, kind, label, phone, me_jid, status, qr_code, ai_enabled,
                created_at, waba_enabled, waba_phone_number_id, waba_provider,
                gupshup_app_id, gupshup_status, tg_token, tg_username,
                ig_page_id, ig_page_name
             FROM accounts 
             WHERE tenant_id=? 
             ORDER BY created_at DESC`,
            [req.user.tenant_id]
        );

        // Remove sensitive data from response
        const safeAccounts = accounts.map(acc => ({
            ...acc,
            waba_access_token: undefined,
            gupshup_app_token: undefined,
            tg_token: acc.tg_token ? '***' : null,
            ig_page_token: undefined
        }));

        res.json({ ok: true, accounts: safeAccounts });
    } catch (err) {
        console.error('[ACCOUNTS] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/accounts/:id
 * @desc Get a specific account by ID
 */
router.get('/:id', authGuard, async (req, res) => {
    try {
        const { id } = req.params;

        const account = await db.get(
            `SELECT 
                id, kind, label, phone, me_jid, status, qr_code, ai_enabled,
                created_at, waba_enabled, waba_phone_number_id, waba_provider,
                gupshup_app_id, gupshup_status, tg_token, tg_username,
                ig_page_id, ig_page_name
             FROM accounts 
             WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!account) {
            return res.status(404).json({ ok: false, error: 'account not found' });
        }

        // Remove sensitive data
        account.waba_access_token = undefined;
        account.gupshup_app_token = undefined;
        account.tg_token = account.tg_token ? '***' : null;
        account.ig_page_token = undefined;

        res.json({ ok: true, account });
    } catch (err) {
        console.error('[ACCOUNTS] GET/:id error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/accounts
 * @desc Create a new messaging account
 */
router.post('/', authGuard, async (req, res) => {
    try {
        const { kind, label, phone, tg_token, tg_username } = req.body || {};

        if (!kind || !['wa', 'tg', 'ig'].includes(kind)) {
            return res.status(400).json({ ok: false, error: 'invalid account kind' });
        }

        if (!label) {
            return res.status(400).json({ ok: false, error: 'label required' });
        }

        // For Telegram, token is required
        if (kind === 'tg' && !tg_token) {
            return res.status(400).json({ ok: false, error: 'telegram token required' });
        }

        const result = await db.run(
            `INSERT INTO accounts(
                tenant_id, kind, label, phone, status, ai_enabled, created_at,
                tg_token, tg_username
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.user.tenant_id,
                kind,
                label,
                phone || null,
                kind === 'wa' ? 'qr' : 'active',
                1,
                Date.now(),
                kind === 'tg' ? tg_token : null,
                kind === 'tg' ? tg_username : null
            ]
        );

        res.json({
            ok: true,
            id: result.lastID,
            message: 'Account created successfully'
        });
    } catch (err) {
        console.error('[ACCOUNTS] POST error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/accounts/:id
 * @desc Update an account
 */
router.put('/:id', authGuard, async (req, res) => {
    try {
        const { id } = req.params;
        const { label, phone, ai_enabled, tg_token, tg_username } = req.body || {};

        // Verify ownership
        const existing = await db.get(
            `SELECT id, kind FROM accounts WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'account not found' });
        }

        // Build update query dynamically
        const updates = [];
        const params = [];

        if (label !== undefined) {
            updates.push('label=?');
            params.push(label);
        }
        if (phone !== undefined) {
            updates.push('phone=?');
            params.push(phone);
        }
        if (ai_enabled !== undefined) {
            updates.push('ai_enabled=?');
            params.push(ai_enabled ? 1 : 0);
        }
        if (existing.kind === 'tg' && tg_token !== undefined) {
            updates.push('tg_token=?');
            params.push(tg_token);
        }
        if (existing.kind === 'tg' && tg_username !== undefined) {
            updates.push('tg_username=?');
            params.push(tg_username);
        }

        if (updates.length === 0) {
            return res.status(400).json({ ok: false, error: 'no fields to update' });
        }

        updates.push('updated_at=?');
        params.push(Date.now());
        params.push(id);
        params.push(req.user.tenant_id);

        await db.run(
            `UPDATE accounts SET ${updates.join(', ')} WHERE id=? AND tenant_id=?`,
            params
        );

        res.json({ ok: true, message: 'Account updated successfully' });
    } catch (err) {
        console.error('[ACCOUNTS] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/accounts/:id
 * @desc Delete an account
 */
router.delete('/:id', authGuard, async (req, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const existing = await db.get(
            `SELECT id FROM accounts WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'account not found' });
        }

        await db.run(
            `DELETE FROM accounts WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        res.json({ ok: true, message: 'Account deleted successfully' });
    } catch (err) {
        console.error('[ACCOUNTS] DELETE error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/accounts/:id/toggle-ai
 * @desc Toggle AI for an account
 */
router.post('/:id/toggle-ai', authGuard, async (req, res) => {
    try {
        const { id } = req.params;
        const { ai_enabled } = req.body || {};

        if (ai_enabled === undefined) {
            return res.status(400).json({ ok: false, error: 'ai_enabled required' });
        }

        // Verify ownership
        const existing = await db.get(
            `SELECT id FROM accounts WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!existing) {
            return res.status(404).json({ ok: false, error: 'account not found' });
        }

        await db.run(
            `UPDATE accounts SET ai_enabled=?, updated_at=? WHERE id=? AND tenant_id=?`,
            [ai_enabled ? 1 : 0, Date.now(), id, req.user.tenant_id]
        );

        res.json({
            ok: true,
            message: ai_enabled ? 'AI enabled' : 'AI disabled',
            ai_enabled: ai_enabled ? 1 : 0
        });
    } catch (err) {
        console.error('[ACCOUNTS] TOGGLE-AI error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/accounts/:id/qr
 * @desc Get QR code for WhatsApp account
 */
router.get('/:id/qr', authGuard, async (req, res) => {
    try {
        const { id } = req.params;

        const account = await db.get(
            `SELECT qr_code, status, kind FROM accounts WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!account) {
            return res.status(404).json({ ok: false, error: 'account not found' });
        }

        if (account.kind !== 'wa') {
            return res.status(400).json({ ok: false, error: 'QR only available for WhatsApp accounts' });
        }

        res.json({
            ok: true,
            qr_code: account.qr_code || null,
            status: account.status
        });
    } catch (err) {
        console.error('[ACCOUNTS] QR error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
