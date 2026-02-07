// src/database/seeds/defaults.js
// Default settings and data for new tenants
// -------------------------------------------------

const { run } = require('../index');

/**
 * Seed default settings for a new tenant
 * @param {number} tenantId - The tenant ID to seed
 */
async function seedDefaultsForTenant(tenantId) {
    const defaults = [
        // AI Settings
        { key: 'ai_model', value: 'gpt-4o-mini' },
        { key: 'ai_temperature', value: '0.7' },
        { key: 'ai_max_tokens', value: '500' },
        { key: 'ai_system_prompt', value: 'Вы - полезный ассистент для бизнеса.' },

        // Registration Settings
        { key: 'open_signup', value: '1' },
        { key: 'open_signup_role', value: 'user' },

        // Moderation Settings
        { key: 'moderation_enabled', value: '0' },

        // SatuCoin Settings
        { key: 'satu_price_per_lead', value: '30' },

        // TTS (Text-to-Speech) Settings
        { key: 'tts_enabled', value: '0' },
        { key: 'tts_voice', value: 'nova' },
        { key: 'tts_smart_mode', value: '1' },

        // Notification Settings
        { key: 'telegram_bot_token', value: '' },
        { key: 'telegram_chat_id', value: '' },
        { key: 'notify_new_lead', value: '1' },
        { key: 'notify_payment_received', value: '1' },

        // Campaign Settings
        { key: 'campaign_delay_ms', value: '1500' },
        { key: 'campaign_batch_size', value: '50' },

        // Knowledge Base Settings
        { key: 'kb_enabled', value: '1' },
        { key: 'kb_similarity_threshold', value: '0.7' },

        // Brand Settings
        { key: 'brand_name', value: 'NeDzat' },
        { key: 'brand_primary_color', value: '#0ea5e9' },

        // Auto-reply Settings
        { key: 'auto_reply_enabled', value: '1' },
        { key: 'auto_reply_delay_ms', value: '1500' },

        // Contact Settings
        { key: 'auto_save_contacts', value: '1' },

        // Media Settings
        { key: 'media_auto_download', value: '1' },
        { key: 'media_max_size_mb', value: '25' }
    ];

    for (const setting of defaults) {
        try {
            await run(
                `INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
                 ON CONFLICT(tenant_id, key) DO NOTHING`,
                [tenantId, setting.key, setting.value]
            );
        } catch (e) {
            console.warn(`[SEED] Failed to insert setting ${setting.key}:`, e?.message || e);
        }
    }

    // Initialize SatuCoin wallet with 0 balance
    try {
        await run(
            `INSERT INTO satu_wallets(tenant_id, balance, updated_at) VALUES(?, ?, ?)
             ON CONFLICT(tenant_id) DO NOTHING`,
            [tenantId, 0, Date.now()]
        );
    } catch (e) {
        console.warn('[SEED] Failed to create wallet:', e?.message || e);
    }

    console.log(`[SEED] Seeded defaults for tenant ${tenantId}`);
}

/**
 * Get a setting value for a tenant
 * @param {string} key - Setting key
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<string|null>} Setting value or null
 */
async function getSetting(key, tenantId) {
    const { get } = require('../index');
    const row = await get(
        `SELECT value FROM settings WHERE tenant_id=? AND key=?`,
        [tenantId, key]
    );
    return row ? row.value : null;
}

/**
 * Set a setting value for a tenant
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 * @param {number} tenantId - Tenant ID
 */
async function setSetting(key, value, tenantId) {
    await run(
        `INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value`,
        [tenantId, key, value]
    );
}

module.exports = {
    seedDefaultsForTenant,
    getSetting,
    setSetting
};
