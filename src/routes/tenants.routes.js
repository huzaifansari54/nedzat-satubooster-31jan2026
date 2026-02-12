const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');

/**
 * @route GET /api/tenants
 * @desc Get current tenant information
 */
router.get('/', authGuard, async (req, res) => {
    try {
        if (!req.user.tenant_id) {
            return res.status(404).json({ ok: false, error: 'no tenant' });
        }

        // Query tenant information from tenants table
        const tenant = await db.get(
            `SELECT id, name, created_at FROM tenants WHERE id=?`,
            [req.user.tenant_id]
        );

        if (!tenant) {
            // If tenant record doesn't exist in tenants table (legacy data),
            // just return the ID
            return res.json({
                ok: true,
                tenant_id: req.user.tenant_id,
                tenant_name: null,
                created_at: null
            });
        }

        res.json({
            ok: true,
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            created_at: tenant.created_at
        });
    } catch (err) {
        console.error('[TENANTS] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/tenants
 * @desc Update tenant name
 */
router.put('/', authGuard, async (req, res) => {
    try {
        const { name } = req.body || {};

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ ok: false, error: 'name required' });
        }

        const trimmedName = name.trim();
        if (trimmedName.length === 0) {
            return res.status(400).json({ ok: false, error: 'name cannot be empty' });
        }

        if (trimmedName.length > 100) {
            return res.status(400).json({ ok: false, error: 'name too long (max 100 chars)' });
        }

        // Check if the new name is already taken by another tenant
        const existing = await db.get(
            `SELECT id FROM tenants WHERE name=? AND id<>?`,
            [trimmedName, req.user.tenant_id]
        );

        if (existing) {
            return res.status(409).json({ ok: false, error: 'tenant name already exists' });
        }

        // Update tenant name
        await db.run(
            `UPDATE tenants SET name=? WHERE id=?`,
            [trimmedName, req.user.tenant_id]
        );

        res.json({
            ok: true,
            message: 'Tenant name updated successfully',
            tenant_id: req.user.tenant_id,
            tenant_name: trimmedName
        });
    } catch (err) {
        console.error('[TENANTS] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/tenants/stats
 * @desc Get tenant statistics (accounts, contacts, messages, etc.)
 */
router.get('/stats', authGuard, async (req, res) => {
    try {
        const tenant_id = req.user.tenant_id;

        // Get counts for various tenant resources
        const [
            accountsCount,
            contactsCount,
            messagesCount,
            campaignsCount,
            kbFilesCount
        ] = await Promise.all([
            db.get(`SELECT COUNT(*) as count FROM accounts WHERE tenant_id=?`, [tenant_id]),
            db.get(`SELECT COUNT(DISTINCT jid) as count FROM chats WHERE tenant_id=?`, [tenant_id]),
            db.get(`SELECT COUNT(*) as count FROM chats WHERE tenant_id=?`, [tenant_id]),
            db.get(`SELECT COUNT(*) as count FROM campaigns WHERE tenant_id=?`, [tenant_id]),
            db.get(`SELECT COUNT(*) as count FROM kb_files WHERE tenant_id=?`, [tenant_id])
        ]);

        res.json({
            ok: true,
            stats: {
                accounts: accountsCount?.count || 0,
                contacts: contactsCount?.count || 0,
                messages: messagesCount?.count || 0,
                campaigns: campaignsCount?.count || 0,
                kb_files: kbFilesCount?.count || 0
            }
        });
    } catch (err) {
        console.error('[TENANTS] GET /stats error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/tenants/all
 * @desc Get all tenants (admin only)
 */
router.get('/all', authGuard, adminOnly, async (req, res) => {
    try {
        const tenants = await db.all(
            `SELECT id, name, created_at FROM tenants ORDER BY created_at DESC`
        );

        // Get user counts for each tenant
        const tenantsWithCounts = await Promise.all(
            tenants.map(async (tenant) => {
                const userCount = await db.get(
                    `SELECT COUNT(*) as count FROM users WHERE tenant_id=?`,
                    [tenant.id]
                );

                return {
                    ...tenant,
                    user_count: userCount?.count || 0
                };
            })
        );

        res.json({
            ok: true,
            tenants: tenantsWithCounts
        });
    } catch (err) {
        console.error('[TENANTS] GET /all error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
