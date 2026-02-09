const { get, run } = require('../../database');

/**
 * Get a setting value for a tenant.
 * Includes special fallback logic for 'openai_key'.
 * @param {string} key 
 * @param {number|string} tenantId 
 * @returns {Promise<string>}
 */
async function getSetting(key, tenantId) {
    const row = await get(
        `SELECT value FROM settings WHERE tenant_id=? AND key=?`,
        [tenantId, key]
    );

    let val = row ? row.value : '';

    // Fallback for OpenAI key from env
    if ((!val || String(val).trim() === '') && key === 'openai_key') {
        val = process.env.OPENAI_API_KEY ||
            process.env.OPENAI_KEY ||
            process.env.OPENAI_TOKEN ||
            '';
    }

    return val || '';
}

/**
 * Set a setting value for a tenant.
 * @param {string} key 
 * @param {string} value 
 * @param {number|string} tenantId 
 */
async function setSetting(key, value, tenantId) {
    await run(
        `INSERT OR REPLACE INTO settings(tenant_id, key, value) VALUES(?, ?, ?)`,
        [tenantId, key, value]
    );
}

module.exports = {
    getSetting,
    setSetting
};
