const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');

// ===================================================================
// ADMIN ROUTES
// ===================================================================
// Admin panel endpoints for system management

/**
 * @route GET /api/admin/dashboard
 * @desc Get admin dashboard statistics
 * @admin Only accessible by admins
 */
router.get('/dashboard', authGuard, adminOnly, async (req, res) => {
    try {
        // Total tenants
        const tenantsResult = await db.get(`SELECT COUNT(*) as total FROM tenants`);

        // Total users
        const usersResult = await db.get(`SELECT COUNT(*) as total FROM users`);

        // Total accounts (WhatsApp, Telegram, Instagram)
        const accountsResult = await db.get(`SELECT COUNT(*) as total FROM accounts`);
        const waAccountsResult = await db.get(`SELECT COUNT(*) as total FROM accounts WHERE kind='wa' OR kind IS NULL`);
        const tgAccountsResult = await db.get(`SELECT COUNT(*) as total FROM accounts WHERE kind='tg'`);
        const igConnectionsResult = await db.get(`SELECT COUNT(*) as total FROM ig_connections WHERE status='connected'`);

        // Total messages (last 30 days)
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const messagesResult = await db.get(
            `SELECT COUNT(*) as total FROM chats WHERE ts >= ?`,
            [thirtyDaysAgo]
        );

        // Total campaigns
        const campaignsResult = await db.get(`SELECT COUNT(*) as total FROM campaigns`);
        const activeCampaignsResult = await db.get(
            `SELECT COUNT(*) as total FROM campaigns WHERE status='running'`
        );

        // SatuCoin total balance across all tenants
        const satuBalanceResult = await db.get(
            `SELECT SUM(balance) as total FROM satu_wallets`
        );

        res.json({
            ok: true,
            stats: {
                tenants: tenantsResult.total || 0,
                users: usersResult.total || 0,
                accounts: {
                    total: accountsResult.total || 0,
                    whatsapp: waAccountsResult.total || 0,
                    telegram: tgAccountsResult.total || 0,
                    instagram: igConnectionsResult.total || 0
                },
                messages: {
                    last30Days: messagesResult.total || 0
                },
                campaigns: {
                    total: campaignsResult.total || 0,
                    active: activeCampaignsResult.total || 0
                },
                satuCoin: {
                    totalBalance: satuBalanceResult.total || 0
                }
            }
        });
    } catch (err) {
        console.error('[ADMIN] GET dashboard error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/admin/tenants
 * @desc Get all tenants with details
 * @query search - Search by tenant name
 * @query limit - Limit results (default: 50)
 * @admin Only accessible by admins
 */
router.get('/tenants', authGuard, adminOnly, async (req, res) => {
    try {
        const search = req.query.search || '';
        const limit = req.query.limit ? Number(req.query.limit) : 50;

        let query = `
            SELECT t.*, 
                   (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) as user_count,
                   (SELECT COUNT(*) FROM accounts WHERE tenant_id = t.id) as account_count,
                   (SELECT balance FROM satu_wallets WHERE tenant_id = t.id) as satu_balance
            FROM tenants t
        `;
        const params = [];

        if (search) {
            query += ` WHERE t.name LIKE ?`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY t.created_at DESC LIMIT ?`;
        params.push(limit);

        const tenants = await db.all(query, params);

        res.json({
            ok: true,
            tenants
        });
    } catch (err) {
        console.error('[ADMIN] GET tenants error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/admin/users
 * @desc Get all users across all tenants
 * @query search - Search by email or name
 * @query tenant_id - Filter by tenant ID
 * @query limit - Limit results (default: 100)
 * @admin Only accessible by admins
 */
router.get('/users', authGuard, adminOnly, async (req, res) => {
    try {
        const search = req.query.search || '';
        const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
        const limit = req.query.limit ? Number(req.query.limit) : 100;

        let query = `
            SELECT u.*, t.name as tenant_name
            FROM users u
            LEFT JOIN tenants t ON t.id = u.tenant_id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (u.email LIKE ? OR u.oauth_name LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        if (tenantId) {
            query += ` AND u.tenant_id = ?`;
            params.push(tenantId);
        }

        query += ` ORDER BY u.created_at DESC LIMIT ?`;
        params.push(limit);

        const users = await db.all(query, params);

        // Remove sensitive fields
        const sanitized = users.map(u => {
            const { pass_hash, reset_token_hash, verify_token_hash, ...safe } = u;
            return safe;
        });

        res.json({
            ok: true,
            users: sanitized
        });
    } catch (err) {
        console.error('[ADMIN] GET users error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/admin/users/:id/disable
 * @desc Disable or enable a user account
 * @body disabled - true to disable, false to enable
 * @admin Only accessible by admins
 */
router.put('/users/:id/disable', authGuard, adminOnly, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const { disabled } = req.body;

        if (typeof disabled !== 'boolean') {
            return res.status(400).json({
                ok: false,
                error: 'disabled field must be a boolean'
            });
        }

        await db.run(
            `UPDATE users SET disabled = ? WHERE id = ?`,
            [disabled ? 1 : 0, userId]
        );

        res.json({
            ok: true,
            message: `User ${disabled ? 'disabled' : 'enabled'} successfully`
        });
    } catch (err) {
        console.error('[ADMIN] PUT users/:id/disable error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/admin/notifications
 * @desc Get all admin notifications
 * @query active_only - Filter to only active notifications
 * @admin Only accessible by admins
 */
router.get('/notifications', authGuard, adminOnly, async (req, res) => {
    try {
        const activeOnly = req.query.active_only === 'true';

        let query = `SELECT * FROM admin_notifications`;
        if (activeOnly) {
            query += ` WHERE is_active = 1`;
        }
        query += ` ORDER BY created_at DESC`;

        const notifications = await db.all(query);

        res.json({
            ok: true,
            notifications
        });
    } catch (err) {
        console.error('[ADMIN] GET notifications error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/admin/notifications
 * @desc Create a new admin notification
 * @body text - Notification text (required)
 * @body image_file - Image file path (optional)
 * @body target_all - Send to all users (boolean, default: false)
 * @body target_user_ids - Array of user IDs (optional, if not target_all)
 * @admin Only accessible by admins
 */
router.post('/notifications', authGuard, adminOnly, async (req, res) => {
    try {
        const { text, image_file, target_all, target_user_ids } = req.body;

        if (!text) {
            return res.status(400).json({
                ok: false,
                error: 'text is required'
            });
        }

        const now = Date.now();
        const result = await db.run(
            `INSERT INTO admin_notifications (text, image_file, target_all, is_active, created_by, created_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
            [text, image_file || null, target_all ? 1 : 0, req.user.id, now]
        );

        const notificationId = result.lastID;

        // Add specific target users if not target_all
        if (!target_all && Array.isArray(target_user_ids) && target_user_ids.length > 0) {
            for (const userId of target_user_ids) {
                await db.run(
                    `INSERT INTO admin_notification_targets (notif_id, user_id) VALUES (?, ?)`,
                    [notificationId, userId]
                );
            }
        }

        res.json({
            ok: true,
            notification_id: notificationId,
            message: 'Notification created successfully'
        });
    } catch (err) {
        console.error('[ADMIN] POST notifications error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/admin/notifications/:id/deactivate
 * @desc Deactivate an admin notification
 * @admin Only accessible by admins
 */
router.put('/notifications/:id/deactivate', authGuard, adminOnly, async (req, res) => {
    try {
        const notificationId = Number(req.params.id);

        await db.run(
            `UPDATE admin_notifications SET is_active = 0 WHERE id = ?`,
            [notificationId]
        );

        res.json({
            ok: true,
            message: 'Notification deactivated successfully'
        });
    } catch (err) {
        console.error('[ADMIN] PUT notifications/:id/deactivate error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/admin/system-stats
 * @desc Get detailed system statistics
 * @admin Only accessible by admins
 */
router.get('/system-stats', authGuard, adminOnly, async (req, res) => {
    try {
        // Database size
        const dbStats = await db.get(`
            SELECT 
                page_count * page_size as total_bytes,
                page_count,
                page_size
            FROM pragma_page_count(), pragma_page_size()
        `);

        // Table row counts
        const tables = [
            'tenants', 'users', 'accounts', 'chats', 'campaigns',
            'contacts', 'profiles', 'kb_files', 'kb_chunks',
            'satu_transactions', 'analytics_sessions', 'analytics_events'
        ];

        const tableCounts = {};
        for (const table of tables) {
            try {
                const result = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
                tableCounts[table] = result.count || 0;
            } catch (err) {
                tableCounts[table] = 0;
            }
        }

        // Recent activity (last 24 hours)
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        const recentChats = await db.get(
            `SELECT COUNT(*) as count FROM chats WHERE ts >= ?`,
            [twentyFourHoursAgo]
        );
        const recentUsers = await db.get(
            `SELECT COUNT(*) as count FROM users WHERE created_at >= ?`,
            [twentyFourHoursAgo]
        );

        res.json({
            ok: true,
            stats: {
                database: {
                    sizeBytes: dbStats.total_bytes || 0,
                    sizeMB: Math.round((dbStats.total_bytes || 0) / 1024 / 1024 * 100) / 100,
                    pageCount: dbStats.page_count || 0,
                    pageSize: dbStats.page_size || 0
                },
                tables: tableCounts,
                recent24h: {
                    messages: recentChats.count || 0,
                    newUsers: recentUsers.count || 0
                }
            }
        });
    } catch (err) {
        console.error('[ADMIN] GET system-stats error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/admin/cleanup/old-data
 * @desc Clean up old data from various tables
 * @body days - Number of days to keep (default: 90)
 * @admin Only accessible by admins
 */
router.post('/cleanup/old-data', authGuard, adminOnly, async (req, res) => {
    try {
        const days = req.body.days ? Number(req.body.days) : 90;
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

        const results = {};

        // Clean up analytics
        const analyticsEvents = await db.run(
            `DELETE FROM analytics_events WHERE ts < ?`,
            [cutoff]
        );
        results.analyticsEvents = analyticsEvents.changes || 0;

        const analyticsSessions = await db.run(
            `DELETE FROM analytics_sessions WHERE last_seen < ?`,
            [cutoff]
        );
        results.analyticsSessions = analyticsSessions.changes || 0;

        // Clean up Instagram dedup records
        const igDedup = await db.run(
            `DELETE FROM ig_webhook_dedup WHERE ts < ?`,
            [cutoff]
        );
        results.igDedup = igDedup.changes || 0;

        // Clean up AI reply dedup (older than 7 days)
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const aiDedup = await db.run(
            `DELETE FROM ai_reply_dedup WHERE created_ts < ?`,
            [sevenDaysAgo]
        );
        results.aiDedup = aiDedup.changes || 0;

        res.json({
            ok: true,
            cleaned: results,
            cutoffDate: new Date(cutoff).toISOString()
        });
    } catch (err) {
        console.error('[ADMIN] POST cleanup/old-data error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/admin/logs/recent
 * @desc Get recent system logs (placeholder for future implementation)
 * @query lines - Number of log lines to return (default: 100)
 * @admin Only accessible by admins
 */
router.get('/logs/recent', authGuard, adminOnly, async (req, res) => {
    try {
        // This is a placeholder - actual implementation would read from log files
        res.json({
            ok: true,
            logs: [],
            message: 'Log viewing not yet implemented'
        });
    } catch (err) {
        console.error('[ADMIN] GET logs/recent error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
