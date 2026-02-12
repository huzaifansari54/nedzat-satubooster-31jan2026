const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');

// Helper function to parse time ranges
function rangeToWindow(range) {
    const now = Math.floor(Date.now() / 1000);
    let from, to, label;

    switch (range) {
        case '1h':
            from = now - 3600;
            to = now;
            label = 'Last 1 Hour';
            break;
        case '24h':
            from = now - 86400;
            to = now;
            label = 'Last 24 Hours';
            break;
        case '7d':
            from = now - 7 * 86400;
            to = now;
            label = 'Last 7 Days';
            break;
        case '30d':
            from = now - 30 * 86400;
            to = now;
            label = 'Last 30 Days';
            break;
        default:
            from = now - 7 * 86400;
            to = now;
            label = 'Last 7 Days';
    }

    return { from, to, label };
}

/**
 * @route GET /api/ai/summary
 * @desc Get AI usage summary (tokens, costs, model breakdown)
 * @access Admin only
 */
router.get('/summary', authGuard, adminOnly, async (req, res) => {
    try {
        const { from, to, label } = rangeToWindow(req.query.range);

        const totals = await db.get(
            `SELECT
               COUNT(*) AS msgs,
               SUM(prompt_tokens) AS pt,
               SUM(completion_tokens) AS ct,
               SUM(total_tokens) AS tt,
               SUM(cost_usd) AS cost,
               SUM(cost_usd_in) AS cost_in,
               SUM(cost_usd_out) AS cost_out,
               SUM(cost_usd_total) AS cost_total
             FROM chats
             WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?`,
            [from, to]
        );

        const by_model = await db.all(
            `SELECT model,
                    COUNT(*) AS msgs,
                    SUM(total_tokens) AS tt,
                    SUM(cost_usd) AS cost
             FROM chats
             WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?
             GROUP BY model
             ORDER BY cost DESC`,
            [from, to]
        );

        res.json({
            ok: true,
            range: label,
            window: { from, to },
            totals: {
                msgs: Number(totals?.msgs || 0),
                prompt_tokens: Number(totals?.pt || 0),
                completion_tokens: Number(totals?.ct || 0),
                total_tokens: Number(totals?.tt || 0),
                cost_usd: Number(totals?.cost || 0),
                cost_usd_in: Number(totals?.cost_in || 0),
                cost_usd_out: Number(totals?.cost_out || 0),
                cost_usd_total: Number(totals?.cost_total || 0)
            },
            by_model
        });
    } catch (err) {
        console.error('[AI] GET /summary error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route GET /api/ai/messages
 * @desc Get AI message details for a specific user
 * @access Admin only
 */
router.get('/messages', authGuard, adminOnly, async (req, res) => {
    try {
        const userId = Number(req.query.user_id || 0);
        if (!userId) {
            return res.status(400).json({ ok: false, error: 'user_id_required' });
        }

        const u = await db.get(`SELECT tenant_id FROM users WHERE id=?`, [userId]);
        if (!u) {
            return res.status(404).json({ ok: false, error: 'user not found' });
        }

        const tenantId = Number(u.tenant_id);
        const { from, to } = rangeToWindow(req.query.range);

        const q = String(req.query.q || '').trim();
        const limit = Math.min(300, Math.max(20, parseInt(req.query.limit || '120', 10)));

        const params = [tenantId, from, to];
        let sql = `
          SELECT id, ts, acc_id, jid, message, model, total_tokens, cost_usd
          FROM chats
          WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?
        `;

        if (q) {
            sql += ` AND message LIKE ?`;
            params.push(`%${q}%`);
        }

        sql += ` ORDER BY ts DESC, id DESC LIMIT ?`;
        params.push(limit);

        const rows = await db.all(sql, params);
        res.json({ ok: true, items: rows });
    } catch (err) {
        console.error('[AI] GET /messages error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route GET /api/ai/costs
 * @desc Get OpenAI organization costs (requires OpenAI API integration)
 * @access Admin only
 * Note: This is a stub - requires openaiOrgGET function from index.js
 */
router.get('/costs', authGuard, adminOnly, async (req, res) => {
    try {
        // ⚠️ STUB: This endpoint requires the openaiOrgGET function from index.js
        // which makes requests to OpenAI's organization API endpoint
        // The original implementation is at index.js line 5626-5642
        //
        // To complete this endpoint:
        // 1. Extract openaiOrgGET into src/services/ai/openai-org.js
        // 2. Import and use it here
        // 3. Or proxy the request through the original endpoint

        res.status(501).json({
            ok: false,
            error: 'costs_not_implemented',
            message: 'OpenAI organization costs endpoint requires the openaiOrgGET service. ' +
                'Use /api/admin/openai/costs for now, or extract the service from index.js line 5626-5642.'
        });
    } catch (err) {
        console.error('[AI] GET /costs error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route GET /api/ai/models
 * @desc Get list of available AI models with usage stats
 * @access Admin only
 */
router.get('/models', authGuard, adminOnly, async (req, res) => {
    try {
        const { from, to } = rangeToWindow(req.query.range || '30d');

        const models = await db.all(
            `SELECT 
                model,
                COUNT(*) as message_count,
                SUM(prompt_tokens) as total_prompt_tokens,
                SUM(completion_tokens) as total_completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost_usd) as total_cost,
                AVG(total_tokens) as avg_tokens_per_message,
                MIN(ts) as first_used,
                MAX(ts) as last_used
             FROM chats
             WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?
             GROUP BY model
             ORDER BY total_cost DESC`,
            [from, to]
        );

        res.json({
            ok: true,
            models: models.map(m => ({
                ...m,
                message_count: Number(m.message_count || 0),
                total_prompt_tokens: Number(m.total_prompt_tokens || 0),
                total_completion_tokens: Number(m.total_completion_tokens || 0),
                total_tokens: Number(m.total_tokens || 0),
                total_cost: Number(m.total_cost || 0),
                avg_tokens_per_message: Number(m.avg_tokens_per_message || 0)
            }))
        });
    } catch (err) {
        console.error('[AI] GET /models error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/ai/stats/tenant/:tenant_id
 * @desc Get AI usage statistics for a specific tenant
 * @access Admin only
 */
router.get('/stats/tenant/:tenant_id', authGuard, adminOnly, async (req, res) => {
    try {
        const tenantId = Number(req.params.tenant_id);
        if (!tenantId) {
            return res.status(400).json({ ok: false, error: 'tenant_id required' });
        }

        const { from, to } = rangeToWindow(req.query.range || '30d');

        const stats = await db.get(
            `SELECT
                COUNT(*) as message_count,
                SUM(prompt_tokens) as prompt_tokens,
                SUM(completion_tokens) as completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost_usd) as total_cost,
                COUNT(DISTINCT acc_id) as accounts_used,
                COUNT(DISTINCT jid) as unique_contacts,
                COUNT(DISTINCT model) as models_used
             FROM chats
             WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?`,
            [tenantId, from, to]
        );

        const by_model = await db.all(
            `SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens, SUM(cost_usd) as cost
             FROM chats
             WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?
             GROUP BY model
             ORDER BY cost DESC`,
            [tenantId, from, to]
        );

        res.json({
            ok: true,
            tenant_id: tenantId,
            stats: {
                message_count: Number(stats?.message_count || 0),
                prompt_tokens: Number(stats?.prompt_tokens || 0),
                completion_tokens: Number(stats?.completion_tokens || 0),
                total_tokens: Number(stats?.total_tokens || 0),
                total_cost: Number(stats?.total_cost || 0),
                accounts_used: Number(stats?.accounts_used || 0),
                unique_contacts: Number(stats?.unique_contacts || 0),
                models_used: Number(stats?.models_used || 0)
            },
            by_model
        });
    } catch (err) {
        console.error('[AI] GET /stats/tenant error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/ai/stats/account/:account_id
 * @desc Get AI usage statistics for a specific account
 * @access Authenticated users (own account only, unless admin)
 */
router.get('/stats/account/:account_id', authGuard, async (req, res) => {
    try {
        const accountId = Number(req.params.account_id);
        if (!accountId) {
            return res.status(400).json({ ok: false, error: 'account_id required' });
        }

        // Verify ownership unless admin
        if (req.user.role !== 'admin') {
            const account = await db.get(
                `SELECT tenant_id FROM accounts WHERE id=?`,
                [accountId]
            );
            if (!account || account.tenant_id !== req.user.tenant_id) {
                return res.status(403).json({ ok: false, error: 'forbidden' });
            }
        }

        const { from, to } = rangeToWindow(req.query.range || '30d');

        const stats = await db.get(
            `SELECT
                COUNT(*) as message_count,
                SUM(prompt_tokens) as prompt_tokens,
                SUM(completion_tokens) as completion_tokens,
                SUM(total_tokens) as total_tokens,
                SUM(cost_usd) as total_cost,
                COUNT(DISTINCT jid) as unique_contacts,
                COUNT(DISTINCT model) as models_used
             FROM chats
             WHERE acc_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?`,
            [accountId, from, to]
        );

        res.json({
            ok: true,
            account_id: accountId,
            stats: {
                message_count: Number(stats?.message_count || 0),
                prompt_tokens: Number(stats?.prompt_tokens || 0),
                completion_tokens: Number(stats?.completion_tokens || 0),
                total_tokens: Number(stats?.total_tokens || 0),
                total_cost: Number(stats?.total_cost || 0),
                unique_contacts: Number(stats?.unique_contacts || 0),
                models_used: Number(stats?.models_used || 0)
            }
        });
    } catch (err) {
        console.error('[AI] GET /stats/account error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/ai/usage/daily
 * @desc Get daily AI usage breakdown for charting
 * @access Admin only
 */
router.get('/usage/daily', authGuard, adminOnly, async (req, res) => {
    try {
        const { from, to } = rangeToWindow(req.query.range || '30d');
        const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;

        let sql = `
            SELECT 
                date,
                COUNT(*) as messages,
                SUM(total_tokens) as tokens,
                SUM(cost_usd) as cost
            FROM chats
            WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?
        `;

        const params = [from, to];

        if (tenantId) {
            sql += ` AND tenant_id=?`;
            params.push(tenantId);
        }

        sql += ` GROUP BY date ORDER BY date ASC`;

        const daily = await db.all(sql, params);

        res.json({
            ok: true,
            daily: daily.map(d => ({
                date: d.date,
                messages: Number(d.messages || 0),
                tokens: Number(d.tokens || 0),
                cost: Number(d.cost || 0)
            }))
        });
    } catch (err) {
        console.error('[AI] GET /usage/daily error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
