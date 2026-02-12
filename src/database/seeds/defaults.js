const { run } = require('../index');

/**
 * Seed default settings for a new tenant
 * @param {number} tenantId - The tenant ID to seed
 */
async function seedDefaultsForTenant(tenantId) {
    const defaults = [
        ['system_prompt', 'Ты вежливый WhatsApp-ассистент. Отвечай кратко, дружелюбно и по делу.'],
        ['delay_sec', '2'],
        ['stopword', 'стоп'],
        ['startword', 'включить'],
        ['block_time_min', '60'],
        ['followup_enabled', '1'],
        ['followup_steps', '[]'],
        ['ctx_messages', '12'],
        ['summary_every_n', '8'],
        ['work_enabled', '0'],
        ['work_tz', 'Asia/Almaty'],
        ['work_rules', '[]'],
        ['lang_auto', '1'],
        ['slots_enabled', '1'],
        ['blacklist_phrases', '["не пишите","удалите номер","stop","отпишитесь"]'],
        ['whitelist_phrases', '["подробнее","давайте","интересно","хочу","купить"]'],
        ['moderation_enabled', '1'],
        ['moderation_badwords', '["оскорб","брань","18+","политика"]'],
        ['escalate_after_out_no_reply', '3'],
        ['escalation_webhook', ''],
        ['telegram_token', ''],
        ['telegram_chat', ''],
        ['telegram_events', '["booked","human_needed","no_reply_after_many_out"]'],
        ['default_model', 'gpt-4o'],
        ['default_temperature', '0.7'],
        ['default_max_tokens', '200'],
        ['fu_gate_enabled', '1'],
        ['fu_done_phrases', '["записал","записала","забронировал","забронировала","оплатил","оплатила","внес предоплату","подтверждаю","подтвердил","оформил","оформлено","готово","приеду","пришла оплата","услуга оказана"]'],
        ['fu_no_follow_phrases', '["не интересно","неактуально","не нужно","откажусь","передумал","больше не пишите","удалите номер","стоп","stop"]'],
        ['open_signup', '1'],
        ['open_signup_role', 'user'],
        ['crm_enabled', '1'],
        ['crm_endpoint', ''],
        ['crm_company_id', ''],
        ['crm_api_key', ''],
        ['crm_msg_endpoint', ''],
        ['public_base_url', ''],
        ['tts_enabled', '0'],
        ['tts_mode', 'both'],
        ['tts_model', 'gpt-4o-mini-tts'],
        ['tts_voice', 'alloy'],
        ['tts_lang', ''],
        ['tts_rate', '1.0'],
        ['tts_pitch', '0'],
        ['ig_system_prompt', 'Ты вежливый Instagram-ассистент. Отвечай кратко, дружелюбно и по делу.'],
        ['ig_delay_sec', '2'],
        ['ig_stopword', ''],
        ['ig_startword', ''],
        ['ig_block_time_min', '0'],
        ['ig_allow_direct', '1'],
        ['ig_allow_comments', '1'],
        ['ig_allow_comment_dm', '0'],
        ['ig_allow_story_mentions', '1'],
        ['ig_allow_post_mentions', '1'],
        ['ig_stoplist', ''],
        ['ig_ctx_messages', '18'],
        ['first_message_enabled', '0'],
        ['first_message_delay_sec', '2'],
        ['first_message_text', ''],
        ['first_message_media_file', ''],
        ['first_message_media_kind', '']
    ];

    for (const [key, value] of defaults) {
        try {
            await run(
                `INSERT INTO settings(tenant_id, key, value) VALUES(?, ?, ?)
                 ON CONFLICT(tenant_id, key) DO NOTHING`,
                [tenantId, key, value]
            );
        } catch (e) {
            console.warn(`[SEED] Failed to insert setting ${key}:`, e?.message || e);
        }
    }

    // Initialize SatuCoin wallet with 0 balance
    try {
        await run(
            `INSERT INTO satu_wallets(tenant_id, balance, updated_at) VALUES(?, ?, ?)
             ON CONFLICT(tenant_id) DO UPDATE SET updated_at = excluded.updated_at`,
            [tenantId, 0, Date.now()]
        );
    } catch (e) {
        console.warn('[SEED] Failed to create wallet:', e?.message || e);
    }

    console.log(`[SEED] Seeded defaults for tenant ${tenantId}`);
}

module.exports = {
    seedDefaultsForTenant
};
