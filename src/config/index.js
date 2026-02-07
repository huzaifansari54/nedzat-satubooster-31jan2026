// src/config/index.js — Main Configuration
// -------------------------------------------------

const database = require('./database');
const cors = require('./cors');
const multer = require('./multer');
const oauth = require('./oauth');
const constants = require('./constants');

module.exports = {
    // Server
    port: process.env.PORT || 3099,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://194.32.141.216:3099').replace(/\/+$/, ''),
    nodeEnv: process.env.NODE_ENV || 'development',

    // Security
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',

    // SMTP
    smtp: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 0),
        secure: String(process.env.SMTP_SECURE || '').trim() === '1',
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        tlsRejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '1').trim() !== '0'
    },

    // Email verification
    verifyResendCooldown: Number(process.env.VERIFY_RESEND_COOLDOWN_MS || 60000),

    // OAuth
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || ''
    },

    apple: {
        clientId: process.env.APPLE_CLIENT_ID || '',
        teamId: process.env.APPLE_TEAM_ID || '',
        keyId: process.env.APPLE_KEY_ID || '',
        privateKeyPath: process.env.APPLE_PRIVATE_KEY_PATH || '',
        privateKey: process.env.APPLE_PRIVATE_KEY || ''
    },

    // Instagram (Meta)
    instagram: {
        appId: process.env.IG_APP_ID || '',
        appSecret: process.env.IG_APP_SECRET || '',
        verifyToken: process.env.IG_VERIFY_TOKEN || ''
    },

    // Gupshup Partner Portal
    gupshup: {
        baseUrl: process.env.GUPSHUP_PARTNER_BASE || 'https://partner.gupshup.io',
        email: process.env.GUPSHUP_PARTNER_EMAIL || '',
        secret: process.env.GUPSHUP_PARTNER_SECRET || ''
    },

    // OpenAI
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        adminKey: process.env.OPENAI_ADMIN_KEY || ''
    },

    // SatuCoin
    satuCoin: {
        defaultPricePerLead: Number(process.env.SATU_PRICE_PER_LEAD || 30)
    },

    // CRM Sync
    crmSync: {
        apiKey: process.env.SYNC_API_KEY || '',
        url: process.env.SATU_CRM_SYNC_URL || 'https://sejeygmlpgseyutuvfhk.supabase.co/functions/v1/sync-user-from-nedzat',
        secret: process.env.SATU_CRM_SYNC_SECRET || ''
    },

    // VAPID (Web Push)
    vapid: {
        publicKey: process.env.VAPID_PUBLIC_KEY || '',
        privateKey: process.env.VAPID_PRIVATE_KEY || ''
    },

    // Paths
    paths: {
        uploads: 'uploads',
        avatars: 'uploads/avatars',
        brand: 'uploads/brand',
        public: 'public'
    },

    // Sub-modules (for direct access if needed)
    database,
    cors,
    multer,
    oauth,
    constants
};
