const { run, all } = require('../../database');

/**
 * Create a new SatuCoin transaction record.
 * @param {Object} params
 * @param {string|number} params.tenantId
 * @param {string|number} [params.userId]
 * @param {number} params.amount
 * @param {string} [params.reason]
 * @param {Object} [params.meta]
 */
async function createTransaction({ tenantId, userId, amount, reason, meta }) {
    const now = Date.now();
    await run(`
    INSERT INTO satu_transactions(tenant_id, user_id, amount, reason, meta, created_at)
    VALUES(?,?,?,?,?,?)
  `, [
        tenantId,
        userId,
        amount, // can be negative or positive
        reason || '',
        JSON.stringify(meta || {}),
        now
    ]);
}

/**
 * Get transaction history for a tenant with pagination.
 * @param {string|number} tenantId
 * @param {number} limit
 * @param {number} offset
 * @returns {Promise<any[]>}
 */
async function getTransactions(tenantId, limit = 50, offset = 0) {
    return await all(
        `SELECT * FROM satu_transactions WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [tenantId, limit, offset]
    );
}

module.exports = {
    createTransaction,
    getTransactions
};
