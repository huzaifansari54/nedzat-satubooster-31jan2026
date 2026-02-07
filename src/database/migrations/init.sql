-- src/database/migrations/init.sql
-- Database Schema for NeDzat SaaS
-- -------------------------------------------------
-- This file documents the existing database schema.
-- The actual database (db.sqlite) already exists and contains this schema.
-- This file serves as documentation and can be used for fresh installations.

-- ===================================================================
-- TENANTS
-- ===================================================================
CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

-- ===================================================================
-- USERS
-- ===================================================================
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    verify_token_exp INTEGER,
    reset_token TEXT,
    reset_token_exp INTEGER,
    google_sub TEXT,
    apple_sub TEXT,
    oauth_name TEXT,
    oauth_picture TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- ===================================================================
-- ACCOUNTS (WhatsApp/Telegram/Instagram accounts)
-- ===================================================================
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'wa',
    label TEXT NOT NULL,
    phone TEXT,
    me_jid TEXT,
    status TEXT NOT NULL DEFAULT 'qr',
    qr_code TEXT,
    ai_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    
    -- WABA (WhatsApp Business API) fields
    waba_enabled INTEGER NOT NULL DEFAULT 0,
    waba_phone_number_id TEXT,
    waba_access_token TEXT,
    waba_provider TEXT,
    
    -- Gupshup fields
    gupshup_app_id TEXT,
    gupshup_app_token TEXT,
    gupshup_status TEXT,
    
    -- Telegram fields
    tg_token TEXT,
    tg_username TEXT,
    
    -- Instagram fields
    ig_page_id TEXT,
    ig_page_token TEXT,
    ig_page_name TEXT,
    
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_tenant_id ON accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

-- ===================================================================
-- CHATS (Message history)
-- ===================================================================
CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL,
    message TEXT,
    type TEXT NOT NULL,
    media_file TEXT,
    media_kind TEXT,
    status TEXT,
    wa_id TEXT,
    crm_ext_id TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_chats_tenant_jid ON chats(tenant_id, jid);
CREATE INDEX IF NOT EXISTS idx_chats_acc_jid ON chats(acc_id, jid);
CREATE INDEX IF NOT EXISTS idx_chats_ts ON chats(ts);
CREATE INDEX IF NOT EXISTS idx_chats_date ON chats(date);

-- ===================================================================
-- CONTACTS
-- ===================================================================
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    phone TEXT,
    name TEXT,
    last_ts INTEGER,
    last_message TEXT,
    last_type TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id),
    UNIQUE(tenant_id, acc_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_acc ON contacts(tenant_id, acc_id);
CREATE INDEX IF NOT EXISTS idx_contacts_jid ON contacts(jid);

-- ===================================================================
-- CAMPAIGNS
-- ===================================================================
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    message_text TEXT,
    media_file TEXT,
    media_kind TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    processing INTEGER NOT NULL DEFAULT 0,
    processing_ts INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_id ON campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- ===================================================================
-- CAMPAIGN CONTACTS
-- ===================================================================
CREATE TABLE IF NOT EXISTS campaign_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    phone TEXT,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at INTEGER,
    error TEXT,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_id ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status ON campaign_contacts(status);

-- ===================================================================
-- KNOWLEDGE BASE
-- ===================================================================
CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tenant_id ON knowledge(tenant_id);

-- ===================================================================
-- SETTINGS
-- ===================================================================
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE(tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_settings_tenant_key ON settings(tenant_id, key);

-- ===================================================================
-- SATU COIN (Payment system)
-- ===================================================================
CREATE TABLE IF NOT EXISTS satu_wallets (
    tenant_id INTEGER PRIMARY KEY,
    balance REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS satu_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    amount REAL NOT NULL,
    reason TEXT,
    meta TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_satu_tx_tenant ON satu_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_satu_tx_created ON satu_transactions(created_at);

CREATE TABLE IF NOT EXISTS satu_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    month_key TEXT NOT NULL,
    first_ts INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id),
    UNIQUE(tenant_id, acc_id, jid, month_key)
);

CREATE INDEX IF NOT EXISTS idx_satu_leads_tenant ON satu_leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_satu_leads_month ON satu_leads(month_key);

-- ===================================================================
-- RECEIPTS (Payment receipts from customers)
-- ===================================================================
CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    ts INTEGER NOT NULL,
    amount REAL,
    currency TEXT,
    file TEXT,
    raw_text TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_tenant ON receipts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_receipts_ts ON receipts(ts);

-- ===================================================================
-- ANALYTICS
-- ===================================================================
CREATE TABLE IF NOT EXISTS analytics_visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    aid TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    page_views INTEGER NOT NULL DEFAULT 1,
    ip TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE(tenant_id, aid)
);

CREATE INDEX IF NOT EXISTS idx_analytics_tenant ON analytics_visitors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_analytics_aid ON analytics_visitors(aid);

-- ===================================================================
-- TELEGRAM NOTIFICATIONS
-- ===================================================================
CREATE TABLE IF NOT EXISTS tg_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    jid TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    UNIQUE(tenant_id, event, jid)
);

CREATE INDEX IF NOT EXISTS idx_tg_sent_tenant ON tg_sent(tenant_id);

-- ===================================================================
-- PHRASE LISTS (Blacklist, Badwords, Whitelist)
-- ===================================================================
CREATE TABLE IF NOT EXISTS phrase_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    list_type TEXT NOT NULL,
    phrase TEXT NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_phrase_lists_tenant ON phrase_lists(tenant_id);
CREATE INDEX IF NOT EXISTS idx_phrase_lists_type ON phrase_lists(list_type);

-- ===================================================================
-- MEDIA TRIGGERS (Auto-reply with media based on keywords)
-- ===================================================================
CREATE TABLE IF NOT EXISTS media_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    keywords TEXT NOT NULL,
    media_file TEXT NOT NULL,
    media_kind TEXT,
    caption TEXT,
    also_reply_text TEXT,
    match_mode TEXT NOT NULL DEFAULT 'any',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_media_triggers_tenant ON media_triggers(tenant_id);

-- ===================================================================
-- ESCALATIONS (Manual intervention requests)
-- ===================================================================
CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    reason TEXT NOT NULL,
    context TEXT,
    created_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON escalations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_escalations_resolved ON escalations(resolved);

-- ===================================================================
-- BRAND SETTINGS (Logo, colors, etc.)
-- ===================================================================
CREATE TABLE IF NOT EXISTS brand_settings (
    tenant_id INTEGER PRIMARY KEY,
    logo_file TEXT,
    primary_color TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
