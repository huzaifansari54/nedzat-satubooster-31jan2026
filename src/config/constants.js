// src/config/constants.js — Application Constants
// -------------------------------------------------

module.exports = {
    // WhatsApp message limits
    WA_MAX_CHARS: 3500,

    // File size limits
    MAX_FILE_SIZE_MB: 100,
    MAX_PDF_SIZE_MB: 25,

    // Text processing
    MAX_CHUNK_CHARS: 3800,
    ROUGH_CHARS_PER_TOKEN: 4,

    // Campaign settings
    CAMPAIGN_HEARTBEAT_INTERVAL_MS: 10000,

    // Email verification
    VERIFY_RESEND_COOLDOWN_MS: Number(process.env.VERIFY_RESEND_COOLDOWN_MS || 60000),

    // Auto-verified email domains
    AUTO_VERIFIED_DOMAINS: ['@deshti.kz', '@satubooster.kz'],

    // Cookie settings
    AUTH_COOKIE_MAX_AGE_MS: 30 * 24 * 3600 * 1000, // 30 days
    ANALYTICS_COOKIE_MAX_AGE_MS: 90 * 24 * 3600 * 1000, // 90 days

    // Telegram notification cooldown
    TG_NOTIFICATION_COOLDOWN_SEC: 7200, // 2 hours

    // AI settings
    AI_REPLY_DELAY_MS: 1500,
    AI_MAX_TOKENS_DEFAULT: 500,

    // Excel parsing limits
    EXCEL_MAX_SHEETS: 3,
    EXCEL_MAX_ROWS: 60,
    EXCEL_MAX_COLS: 20,

    // CRM sync
    CRM_FUNCTIONS_BASE: 'https://sejeygmlpgseyutuvfhk.supabase.co/functions/v1',

    // Gupshup Partner Portal
    GUPSHUP_BASE_URL: process.env.GUPSHUP_PARTNER_BASE || 'https://partner.gupshup.io',
    GUPSHUP_TOKEN_EXPIRY_MS: 50 * 60 * 1000, // 50 minutes

    // Media processing timeouts
    FFMPEG_TIMEOUT_MS: 40000,
    PDF_RENDER_TIMEOUT_MS: 15000,

    // Audio settings
    AUDIO_SAMPLE_RATE: 16000,
    AUDIO_BITRATE: '24k',
    AUDIO_CHANNELS: 1, // mono

    // Status values
    ACCOUNT_STATUS: {
        QR: 'qr',
        CONNECTING: 'connecting',
        ONLINE: 'online',
        OFFLINE: 'offline'
    },

    // User roles
    USER_ROLES: {
        ADMIN: 'admin',
        USER: 'user',
        VIEWER: 'viewer'
    }
};
