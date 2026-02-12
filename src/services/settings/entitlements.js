const db = require('../../database');

const FEATURES = {
    FOLLOWUP_TEMPLATE: 1 << 0,
    FOLLOWUP_AI: 1 << 1,
    BROADCAST: 1 << 2,
    KB: 1 << 3,
    TG_INTEGRATION: 1 << 5,
    CRM: 1 << 6,
    SET_PROMPT: 1 << 7,
    SET_FIRSTMSG: 1 << 8,
    SET_TTS: 1 << 9,
    SET_AI_MOD: 1 << 10,
    SET_STOPLIST: 1 << 11,
    SET_DEFAULT_MAX: 1 << 12,
    SET_RECEIPTS_PDF: 1 << 13,
};

const FEATURE_ALL = Object.values(FEATURES).reduce((a, b) => a | b, 0);

function maskHas(mask, bit) {
    return ((Number(mask) || 0) & bit) === bit;
}

/**
 * Get setting value for a tenant (helper)
 */
async function getSetting(key, tenantId) {
    const row = await db.get(
        `SELECT value FROM settings WHERE tenant_id=? AND key=?`,
        [tenantId, key]
    );
    return row ? row.value : null;
}

/**
 * Get tenant entitlements (features and limits)
 */
async function getTenantEntitlements(tenantId) {
    const tid = Number(tenantId || 0);

    // Get feature mask
    const rawMask = await getSetting('ent_feature_mask', tid);
    const feature_mask = (rawMask === null || rawMask === undefined || rawMask === '')
        ? FEATURE_ALL
        : Number(rawMask);

    // Get limits
    let wa_max = await getSetting('ent_wa_max', tid);
    wa_max = (wa_max === null || wa_max === '') ? 10 : Number(wa_max);

    let tg_max = await getSetting('ent_tg_max', tid);
    tg_max = (tg_max === null || tg_max === '') ? 999 : Number(tg_max);

    // Get plan info
    let plan_id = await getSetting('ent_plan_id', tid);
    plan_id = plan_id ? Number(plan_id) : null;

    let plan = null;
    if (plan_id) {
        plan = await db.get(
            'SELECT id, name, price_kzt, wa_max, tg_max, feature_mask FROM tariff_plans WHERE id=?',
            [plan_id]
        );
        if (!plan) {
            const legacyName = await getSetting('tariff_plan', tid);
            plan = { id: plan_id, name: legacyName || '', price_kzt: null };
        }
    } else {
        const legacyName = await getSetting('tariff_plan', tid);
        if (legacyName) plan = { id: null, name: legacyName, price_kzt: null };
    }

    const features = {
        followup_template: maskHas(feature_mask, FEATURES.FOLLOWUP_TEMPLATE),
        followup_ai: maskHas(feature_mask, FEATURES.FOLLOWUP_AI),
        broadcast: maskHas(feature_mask, FEATURES.BROADCAST),
        kb: maskHas(feature_mask, FEATURES.KB),
        tg_integration: maskHas(feature_mask, FEATURES.TG_INTEGRATION),
        crm: maskHas(feature_mask, FEATURES.CRM),
        set_prompt: maskHas(feature_mask, FEATURES.SET_PROMPT),
        set_firstmsg: maskHas(feature_mask, FEATURES.SET_FIRSTMSG),
        set_tts: maskHas(feature_mask, FEATURES.SET_TTS),
        set_ai_mod: maskHas(feature_mask, FEATURES.SET_AI_MOD),
        set_stoplist: maskHas(feature_mask, FEATURES.SET_STOPLIST),
        set_default_max: maskHas(feature_mask, FEATURES.SET_DEFAULT_MAX),
        set_receipts_pdf: maskHas(feature_mask, FEATURES.SET_RECEIPTS_PDF),
    };

    return {
        features,
        wa_max,
        tg_max,
        plan,
        feature_mask
    };
}

module.exports = {
    FEATURES,
    getTenantEntitlements,
    maskHas
};
