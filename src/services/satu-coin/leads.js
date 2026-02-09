const { run, get } = require('../../database');
const { getMonthKey } = require('../../utils/time');
const { getSatuPricePerLead, changeSatuBalance } = require('./wallet');

// Global mutex chain for critical transactions
let _satuTxChain = Promise.resolve();

/**
 * Acquire a lock for critical SatuCoin transactions to prevent race conditions.
 * @returns {Promise<Function>} Unlock function
 */
async function satuTxLock() {
    let unlock;
    const gate = new Promise(res => (unlock = res));
    const prev = _satuTxChain;
    _satuTxChain = prev.then(() => gate);
    await prev;
    return unlock;
}

/**
 * Check if a lead has already been paid for in the current month.
 * @param {Object} params
 * @param {string|number} params.tenantId
 * @param {string|number} params.accId
 * @param {string} params.jid
 * @param {number} [params.tsMs]
 * @returns {Promise<boolean>}
 */
async function isLeadPaidThisMonth({ tenantId, accId, jid, tsMs = Date.now() }) {
    const monthKey = getMonthKey(tsMs);
    const row = await get(
        `SELECT 1 FROM satu_leads WHERE tenant_id=? AND acc_id=? AND jid=? AND month_key=?`,
        [tenantId, accId, jid, monthKey]
    );
    return !!row;
}

/**
 * Charge for a lead if it hasn't been charged this month.
 * Uses a transaction and mutex lock.
 * @param {Object} params
 * @param {string|number} params.tenantId
 * @param {string|number} params.accId
 * @param {string} params.jid
 * @param {string|number} [params.userId]
 */
async function chargeSatuForLeadIfNeeded({ tenantId, accId, jid, userId = null }) {
    const unlock = await satuTxLock();

    try {
        const ts = Date.now();
        const monthKey = getMonthKey(ts);

        await run('BEGIN IMMEDIATE');

        try {
            // Try to insert lead record (atomic check-and-set via unique constraint)
            const ins = await run(
                `INSERT INTO satu_leads(tenant_id, acc_id, jid, month_key, first_ts)
         VALUES(?,?,?,?,?)
         ON CONFLICT(tenant_id, acc_id, jid, month_key) DO NOTHING`,
                [tenantId, accId, jid, monthKey, ts]
            );

            // If nothing inserted, it means we already paid for this lead this month
            if (!ins || ins.changes === 0) {
                await run('COMMIT');
                return;
            }

            const price = await getSatuPricePerLead(tenantId);

            // Double check balance before deduction (redundant with wallet check but good for clarity)
            const row = await get(`SELECT balance FROM satu_wallets WHERE tenant_id=?`, [tenantId]);
            const bal = row ? Number(row.balance || 0) : 0;

            if (bal < price) {
                const err = new Error('SATU_NO_FUNDS');
                err.code = 'SATU_NO_FUNDS';
                throw err;
            }

            // Deduct balance
            await changeSatuBalance(tenantId, -price, {
                userId,
                reason: 'lead_month',
                meta: { acc_id: accId, jid, month: monthKey }
            });

            await run('COMMIT');
        } catch (e) {
            try { await run('ROLLBACK'); } catch (_) { }
            throw e;
        }
    } finally {
        try { unlock(); } catch (_) { }
    }
}

module.exports = {
    isLeadPaidThisMonth,
    chargeSatuForLeadIfNeeded,
    satuTxLock
};
