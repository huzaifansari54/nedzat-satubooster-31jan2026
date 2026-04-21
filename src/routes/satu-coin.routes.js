const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');
const { logger } = require('../utils');
const satuCoin = require('../services/satu-coin');

// ===================================================================
// SATU-COIN ROUTES
// ===================================================================
// Wallet, transactions, and lead management endpoints

/**
 * @route GET /api/satu-coin/balance
 * @desc Get SatuCoin balance for the authenticated user's tenant
 */
router.get('/balance', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const balance = await satuCoin.getSatuBalance(tenantId);
        const pricePerLead = await satuCoin.getSatuPricePerLead(tenantId);

        res.json({
            ok: true,
            balance,
            pricePerLead,
            leadsRemaining: Math.floor(balance / pricePerLead)
        });
    } catch (err) {
        console.error('[SATU-COIN] GET balance error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/satu-coin/topup
 * @desc Add funds to a tenant's wallet (admin only)
 * @body tenant_id - Target tenant ID
 * @body amount - Amount to add (positive integer)
 * @body reason - Reason for topup (optional)
 */
router.post('/topup', authGuard, adminOnly, async (req, res) => {
    try {
        const { tenant_id, amount, reason } = req.body;

        if (!tenant_id || !amount) {
            return res.status(400).json({
                ok: false,
                error: 'tenant_id and amount are required'
            });
        }

        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                ok: false,
                error: 'amount must be a positive number'
            });
        }

        const newBalance = await satuCoin.changeSatuBalance(
            tenant_id,
            amountNum,
            {
                userId: req.user.id,
                reason: reason || 'admin_topup',
                meta: { admin_user_id: req.user.id }
            }
        );

        res.json({
            ok: true,
            newBalance,
            message: `Added ${amountNum} SatuCoin to tenant ${tenant_id}`
        });
    } catch (err) {
        console.error('[SATU-COIN] POST topup error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/satu-coin/deduct
 * @desc Deduct funds from a tenant's wallet (admin only)
 * @body tenant_id - Target tenant ID
 * @body amount - Amount to deduct (positive integer)
 * @body reason - Reason for deduction (optional)
 */
router.post('/deduct', authGuard, adminOnly, async (req, res) => {
    try {
        const { tenant_id, amount, reason } = req.body;

        if (!tenant_id || !amount) {
            return res.status(400).json({
                ok: false,
                error: 'tenant_id and amount are required'
            });
        }

        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                ok: false,
                error: 'amount must be a positive number'
            });
        }

        const newBalance = await satuCoin.changeSatuBalance(
            tenant_id,
            -amountNum,
            {
                userId: req.user.id,
                reason: reason || 'admin_deduct',
                meta: { admin_user_id: req.user.id }
            }
        );

        res.json({
            ok: true,
            newBalance,
            message: `Deducted ${amountNum} SatuCoin from tenant ${tenant_id}`
        });
    } catch (err) {
        console.error('[SATU-COIN] POST deduct error:', err.message);

        if (err.code === 'SATU_NO_FUNDS') {
            return res.status(400).json({
                ok: false,
                error: 'Insufficient funds'
            });
        }

        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/transactions
 * @desc Get transaction history for the authenticated user's tenant
 * @query limit - Number of transactions to return (default: 50, max: 200)
 * @query offset - Offset for pagination (default: 0)
 */
router.get('/transactions', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        let limit = req.query.limit ? Number(req.query.limit) : 50;
        const offset = req.query.offset ? Number(req.query.offset) : 0;

        // Limit validation
        limit = Math.max(1, Math.min(limit, 200));

        const transactions = await satuCoin.getTransactions(tenantId, limit, offset);

        // Parse meta JSON for each transaction
        const enriched = transactions.map(tx => ({
            ...tx,
            meta: tx.meta ? JSON.parse(tx.meta) : null
        }));

        res.json({
            ok: true,
            transactions: enriched,
            limit,
            offset
        });
    } catch (err) {
        console.error('[SATU-COIN] GET transactions error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/all-balances
 * @desc Get balances for all tenants (admin only)
 * @query min_balance - Filter tenants with at least this balance (optional)
 */
router.get('/all-balances', authGuard, adminOnly, async (req, res) => {
    try {
        const minBalance = req.query.min_balance ? Number(req.query.min_balance) : null;

        let query = `
            SELECT w.tenant_id, w.balance, w.updated_at, t.name as tenant_name
            FROM satu_wallets w
            LEFT JOIN tenants t ON t.id = w.tenant_id
        `;

        const params = [];
        if (minBalance !== null && Number.isFinite(minBalance)) {
            query += ` WHERE w.balance >= ?`;
            params.push(minBalance);
        }

        query += ` ORDER BY w.balance DESC`;

        const wallets = await db.all(query, params);

        const total = wallets.reduce((sum, w) => sum + (w.balance || 0), 0);

        res.json({
            ok: true,
            wallets,
            totalBalance: total,
            count: wallets.length
        });
    } catch (err) {
        console.error('[SATU-COIN] GET all-balances error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/leads
 * @desc Get lead tracking data for the current tenant
 * @query month - Month key (YYYY-MM format, e.g., '2026-02') (optional, defaults to current month)
 * @query acc_id - Filter by account ID (optional)
 */
router.get('/leads', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const { getMonthKey } = require('../utils/time');
        const monthKey = req.query.month || getMonthKey(Date.now());
        const accId = req.query.acc_id ? Number(req.query.acc_id) : null;

        let query = `
            SELECT acc_id, jid, month_key, first_ts
            FROM satu_leads
            WHERE tenant_id = ? AND month_key = ?
        `;
        const params = [tenantId, monthKey];

        if (accId) {
            query += ` AND acc_id = ?`;
            params.push(accId);
        }

        query += ` ORDER BY first_ts DESC`;

        const leads = await db.all(query, params);

        // Get total count and unique JIDs
        const uniqueJids = new Set(leads.map(l => l.jid)).size;

        res.json({
            ok: true,
            monthKey,
            leads,
            totalLeads: leads.length,
            uniqueContacts: uniqueJids
        });
    } catch (err) {
        console.error('[SATU-COIN] GET leads error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/leads/summary
 * @desc Get lead summary by month for the current tenant
 * @query months - Number of months to include (default: 6)
 */
router.get('/leads/summary', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const months = req.query.months ? Number(req.query.months) : 6;

        const summary = await db.all(
            `SELECT 
                month_key,
                COUNT(*) as lead_count,
                COUNT(DISTINCT jid) as unique_contacts,
                COUNT(DISTINCT acc_id) as accounts_used
             FROM satu_leads
             WHERE tenant_id = ?
             GROUP BY month_key
             ORDER BY month_key DESC
             LIMIT ?`,
            [tenantId, months]
        );

        res.json({
            ok: true,
            summary
        });
    } catch (err) {
        console.error('[SATU-COIN] GET leads/summary error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/stats
 * @desc Get SatuCoin statistics for the current tenant
 */
router.get('/stats', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        // Current balance
        const balance = await satuCoin.getSatuBalance(tenantId);
        const pricePerLead = await satuCoin.getSatuPricePerLead(tenantId);

        // Total spent (sum of negative transactions)
        const spentResult = await db.get(
            `SELECT SUM(ABS(amount)) as total
             FROM satu_transactions
             WHERE tenant_id = ? AND amount < 0`,
            [tenantId]
        );

        // Total topped up (sum of positive transactions)
        const toppedResult = await db.get(
            `SELECT SUM(amount) as total
             FROM satu_transactions
             WHERE tenant_id = ? AND amount > 0`,
            [tenantId]
        );

        // Total leads (current month)
        const { getMonthKey } = require('../utils/time');
        const currentMonth = getMonthKey(Date.now());
        const leadsThisMonth = await db.get(
            `SELECT COUNT(*) as count
             FROM satu_leads
             WHERE tenant_id = ? AND month_key = ?`,
            [tenantId, currentMonth]
        );

        // Total leads (all time)
        const leadsAllTime = await db.get(
            `SELECT COUNT(*) as count
             FROM satu_leads
             WHERE tenant_id = ?`,
            [tenantId]
        );

        // Recent transactions
        const recentTransactions = await satuCoin.getTransactions(tenantId, 10, 0);

        res.json({
            ok: true,
            stats: {
                balance,
                pricePerLead,
                leadsRemaining: Math.floor(balance / pricePerLead),
                totalSpent: spentResult.total || 0,
                totalToppedUp: toppedResult.total || 0,
                leadsThisMonth: leadsThisMonth.count || 0,
                leadsAllTime: leadsAllTime.count || 0
            },
            recentTransactions: recentTransactions.map(tx => ({
                ...tx,
                meta: tx.meta ? JSON.parse(tx.meta) : null
            }))
        });
    } catch (err) {
        console.error('[SATU-COIN] GET stats error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/satu-coin/price
 * @desc Get price per lead for the current tenant
 */
router.get('/price', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const pricePerLead = await satuCoin.getSatuPricePerLead(tenantId);

        res.json({
            ok: true,
            pricePerLead,
            currency: 'SatuCoin'
        });
    } catch (err) {
        console.error('[SATU-COIN] GET price error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/satu-coin/check-funds
 * @desc Check if tenant has sufficient funds for chat interactions
 */
router.post('/check-funds', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const result = await satuCoin.ensureSatuEnoughForChat(tenantId);

        res.json({
            ok: true,
            hasFunds: true,
            balance: result.balance,
            pricePerLead: result.price
        });
    } catch (err) {
        logger.error({ err }, '[SATU-COIN] Route error');

        if (err.code === 'SATU_NO_FUNDS') {
            return res.json({
                ok: true,
                hasFunds: false,
                balance: await satuCoin.getSatuBalance(req.user.tenant_id),
                pricePerLead: await satuCoin.getSatuPricePerLead(req.user.tenant_id)
            });
        }

        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
