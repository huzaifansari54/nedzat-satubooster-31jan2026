const { get, run } = require('../../database');
const { getSetting } = require('../settings');
const { createTransaction, getTransactions } = require('./transactions');

// 1 lead (unique client per month) = N SatuCoin
const SATU_DEFAULT_PRICE_PER_LEAD = Number(process.env.SATU_PRICE_PER_LEAD || 30);

/**
 * Get current SatuCoin balance for a tenant.
 * @param {string|number} tenantId
 * @returns {Promise<number>}
 */
async function getSatuBalance(tenantId) {
    const row = await get(
        `SELECT balance FROM satu_wallets WHERE tenant_id=?`,
        [tenantId]
    );
    return row ? row.balance : 0;
}

/**
 * Change balance by delta (positive or negative).
 * Records a transaction.
 * @param {string|number} tenantId
 * @param {number} delta
 * @param {Object} context
 * @param {string|number} [context.userId]
 * @param {string} [context.reason]
 * @param {Object} [context.meta]
 * @returns {Promise<number>} New balance
 */
async function changeSatuBalance(tenantId, delta, {
    userId = null,
    reason = '',
    meta = {}
} = {}) {
    const now = Date.now();
    const d = Number(delta);

    if (!Number.isFinite(d) || d === 0) {
        return await getSatuBalance(tenantId);
    }

    // Check sufficient funds for deduction
    if (d < 0) {
        const cur = Number(await getSatuBalance(tenantId) || 0);
        if (cur + d < 0) {
            const err = new Error('SATU_NO_FUNDS');
            err.code = 'SATU_NO_FUNDS';
            throw err;
        }
    }

    // Upsert wallet balance
    await run(`
    INSERT INTO satu_wallets(tenant_id, balance, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      balance = balance + excluded.balance,
      updated_at = excluded.updated_at
  `, [tenantId, d, now]);

    // Log transaction
    await createTransaction({
        tenantId,
        userId,
        amount: d,
        reason,
        meta
    });

    return await getSatuBalance(tenantId);
}

/**
 * Get price per lead for tenant (from settings or default).
 * @param {string|number} tenantId
 * @returns {Promise<number>}
 */
async function getSatuPricePerLead(tenantId) {
    const raw = await getSetting('satu_price_per_lead', tenantId); // uses ../settings/index.js
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    return SATU_DEFAULT_PRICE_PER_LEAD;
}

/**
 * Ensure tenant has enough balance for at least one lead (or chat interaction).
 * Throws SATU_NO_FUNDS if not enough.
 * @param {string|number} tenantId
 * @returns {Promise<{balance: number, price: number}>}
 */
async function ensureSatuEnoughForChat(tenantId) {
    const price = await getSatuPricePerLead(tenantId);
    const balance = await getSatuBalance(tenantId);

    if (balance < price) {
        const err = new Error('SatuCoin balance is zero or not enough');
        err.code = 'SATU_NO_FUNDS';
        throw err;
    }

    return { balance, price };
}

module.exports = {
    getSatuBalance,
    changeSatuBalance,
    getSatuPricePerLead,
    ensureSatuEnoughForChat,
    getTransactions, // re-export
    SATU_DEFAULT_PRICE_PER_LEAD,
};
