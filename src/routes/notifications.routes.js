const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard } = require('../middleware/auth');
const { logger } = require('../utils');

/**
 * @route GET /api/notify/pending
 * @desc Get targeted or global admin notifications for the current user
 */
router.get('/pending', authGuard, async (req, res) => {
    try {
        const uid = req.user.id;
        const isAdmin = (req.user.role === 'admin');

        const item = await db.get(`
            SELECT n.id, n.text, n.image_file, n.created_at
            FROM admin_notifications n
            LEFT JOIN admin_notification_views v
                ON v.notif_id = n.id AND v.user_id = ?
            WHERE n.is_active = 1
                AND v.notif_id IS NULL
                AND (
                    (${isAdmin ? 0 : 1} AND n.target_all = 1)
                    OR EXISTS(
                        SELECT 1 FROM admin_notification_targets t
                        WHERE t.notif_id = n.id AND t.user_id = ?
                    )
                )
            ORDER BY n.created_at DESC
            LIMIT 1
        `, [uid, uid]);

        if (!item) return res.json({ ok: true, item: null });

        const image_url = item.image_file ? ('/' + String(item.image_file).replace(/^\/+/, '')) : null;

        res.json({
            ok: true,
            item: {
                id: item.id,
                text: item.text,
                image_url,
                created_at: item.created_at
            }
        });
    } catch (err) {
        logger.error({ err }, '[NOTIFY] /pending error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/notify/seen
 * @desc Mark a notification as seen by the user
 */
router.post('/seen', authGuard, async (req, res) => {
    try {
        const uid = req.user.id;
        const id = Number(req.body?.id || 0);
        if (!id) return res.status(400).json({ ok: false, error: 'id required' });

        const n = await db.get(`SELECT id, target_all, is_active FROM admin_notifications WHERE id=?`, [id]);
        if (!n || Number(n.is_active || 0) !== 1) {
            return res.status(404).json({ ok: false, error: 'not found' });
        }

        // Check if user was a target
        if (Number(n.target_all || 0) === 1) {
            if (req.user.role === 'admin') return res.status(403).json({ ok: false, error: 'forbidden' });
        } else {
            const t = await db.get(`SELECT 1 x FROM admin_notification_targets WHERE notif_id=? AND user_id=?`, [id, uid]);
            if (!t) return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        await db.run(
            `INSERT OR IGNORE INTO admin_notification_views(notif_id, user_id, seen_at) VALUES(?,?,?)`,
            [id, uid, Date.now()]
        );
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err }, '[NOTIFY] /seen error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
