-- ============================================
-- Migration: Add Production Features
-- Date: 2026-02-04
-- Description: Adds missing tables and fields from production database
-- Based on: database structure.txt
-- ============================================

-- Start transaction for safety
BEGIN TRANSACTION;

-- ===================================================================
-- STEP 1: ADD MISSING CRITICAL TABLES
-- ===================================================================

-- 1. API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    label TEXT,
    key TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    created_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 2. Customer Profiles (CRM)
CREATE TABLE IF NOT EXISTS profiles (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    name TEXT,
    city TEXT,
    budget TEXT,
    interest TEXT,
    notes TEXT,
    lang TEXT,
    last_intent TEXT,
    summary TEXT,
    stage TEXT,
    slots_updated_at INTEGER,
    crm_id TEXT,
    crm_url TEXT,
    PRIMARY KEY (tenant_id, acc_id, jid),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc ON profiles(tenant_id, acc_id);
CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc_jid ON profiles(tenant_id, acc_id, jid);

-- 3. Contact Blocking
CREATE TABLE IF NOT EXISTS blocks (
    tenant_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    until INTEGER,
    PRIMARY KEY(tenant_id, jid),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 4. Follow-up Tracking
CREATE TABLE IF NOT EXISTS followups (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    step INTEGER NOT NULL,
    sent_ts INTEGER,
    PRIMARY KEY(tenant_id, acc_id, jid, step),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_followups_tenant_acc_jid ON followups(tenant_id, acc_id, jid);

-- 5. Message Templates
CREATE TABLE IF NOT EXISTS msg_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    title TEXT,
    body TEXT,
    media_file TEXT,
    media_kind TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 6. Account Slot Management
CREATE TABLE IF NOT EXISTS acc_slots (
    tenant_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    slot INTEGER NOT NULL,
    public_id TEXT,
    bound_acc_id INTEGER,
    bound_key TEXT,
    updated_at INTEGER,
    PRIMARY KEY (tenant_id, kind, slot),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_slots_public_id ON acc_slots(public_id);
CREATE INDEX IF NOT EXISTS idx_acc_slots_bound_acc_id ON acc_slots(bound_acc_id);

-- 7. LID Mapping (WhatsApp)
CREATE TABLE IF NOT EXISTS lid_mapping (
    acc_id INTEGER NOT NULL,
    lid TEXT NOT NULL,
    phone_jid TEXT,
    phone_number TEXT,
    is_verified INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0,
    PRIMARY KEY(acc_id, lid),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

-- 8. Delete Protection
CREATE TABLE IF NOT EXISTS delete_guard (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    until_ts INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

-- 9. AI Reply Deduplication
CREATE TABLE IF NOT EXISTS ai_reply_dedup (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    in_wa_id TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    out_ext_id TEXT,
    PRIMARY KEY (tenant_id, acc_id, jid, in_wa_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_dedup_created ON ai_reply_dedup(tenant_id, created_ts);

-- 10. Message Reactions
CREATE TABLE IF NOT EXISTS msg_reactions (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    msg_ref TEXT NOT NULL,
    reactions_json TEXT,
    updated_at INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid, msg_ref),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_msg_reactions_lookup ON msg_reactions(tenant_id, acc_id, jid, msg_ref);

-- 11. WhatsApp Message Retry Counter
CREATE TABLE IF NOT EXISTS wa_msg_retry_counter (
    acc_id INTEGER NOT NULL,
    msg_id TEXT NOT NULL,
    retry_count INTEGER DEFAULT 0,
    updated_at INTEGER,
    PRIMARY KEY(acc_id, msg_id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_wa_retry_acc ON wa_msg_retry_counter(acc_id);

-- ===================================================================
-- STEP 2: EXTEND EXISTING TABLES
-- ===================================================================

-- Extend users table
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN push_subscription TEXT;
ALTER TABLE users ADD COLUMN verify_sent_at INTEGER;
ALTER TABLE users ADD COLUMN reset_sent_at INTEGER;

-- Extend accounts table
ALTER TABLE accounts ADD COLUMN folder TEXT;
ALTER TABLE accounts ADD COLUMN public_id TEXT;
ALTER TABLE accounts ADD COLUMN slot INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN wa_engine TEXT DEFAULT 'baileys';
ALTER TABLE accounts ADD COLUMN updated_at INTEGER;
ALTER TABLE accounts ADD COLUMN model TEXT;
ALTER TABLE accounts ADD COLUMN temperature REAL;
ALTER TABLE accounts ADD COLUMN max_tokens INTEGER;
ALTER TABLE accounts ADD COLUMN forced_lang TEXT;
ALTER TABLE accounts ADD COLUMN wa_last_disc_at INTEGER;
ALTER TABLE accounts ADD COLUMN wa_last_disc_code INTEGER;
ALTER TABLE accounts ADD COLUMN wa_last_disc_msg TEXT;
ALTER TABLE accounts ADD COLUMN waba_business_account_id TEXT;
ALTER TABLE accounts ADD COLUMN waba_verify_token TEXT;
ALTER TABLE accounts ADD COLUMN waba_app_secret TEXT;
ALTER TABLE accounts ADD COLUMN tg_offset INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_id ON accounts(public_id);
CREATE INDEX IF NOT EXISTS idx_accounts_waba_enabled ON accounts(waba_enabled);
CREATE INDEX IF NOT EXISTS idx_accounts_waba_phone_id ON accounts(waba_phone_number_id);

-- Extend chats table
ALTER TABLE chats ADD COLUMN campaign_id INTEGER;
ALTER TABLE chats ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE chats ADD COLUMN completion_tokens INTEGER;
ALTER TABLE chats ADD COLUMN total_tokens INTEGER;
ALTER TABLE chats ADD COLUMN model TEXT;
ALTER TABLE chats ADD COLUMN cost_usd_in REAL DEFAULT 0;
ALTER TABLE chats ADD COLUMN cost_usd_out REAL DEFAULT 0;
ALTER TABLE chats ADD COLUMN cost_usd_total REAL DEFAULT 0;
ALTER TABLE chats ADD COLUMN openai_req_id TEXT;
ALTER TABLE chats ADD COLUMN media_name TEXT;
ALTER TABLE chats ADD COLUMN media_mime TEXT;
ALTER TABLE chats ADD COLUMN media_size INTEGER;
ALTER TABLE chats ADD COLUMN push_name TEXT;

-- Add indexes for chats
CREATE INDEX IF NOT EXISTS idx_chats_tenant_type_ts ON chats(tenant_id, type, ts);
CREATE INDEX IF NOT EXISTS idx_chats_acc_type_ts ON chats(acc_id, type, ts);
CREATE INDEX IF NOT EXISTS idx_chats_tenant_acc_jid_ts ON chats(tenant_id, acc_id, jid, ts);
CREATE INDEX IF NOT EXISTS idx_chats_tenant_campaign_ts ON chats(tenant_id, campaign_id, ts);
CREATE INDEX IF NOT EXISTS idx_chats_hist_fast ON chats(tenant_id, acc_id, jid, ts DESC, id DESC);

-- Add unique constraint for wa_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_unique_wa_id 
    ON chats(tenant_id, acc_id, jid, wa_id)
    WHERE wa_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_tenant_crmext
    ON chats(tenant_id, crm_ext_id)
    WHERE crm_ext_id IS NOT NULL;

-- Extend campaigns table
ALTER TABLE campaigns ADD COLUMN settings_json TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_status_proc ON campaigns(status, processing);
CREATE INDEX IF NOT EXISTS idx_campaigns_proc_ts ON campaigns(processing, processing_ts);

-- Extend contacts table
ALTER TABLE contacts ADD COLUMN push_name TEXT;
ALTER TABLE contacts ADD COLUMN notify TEXT;
ALTER TABLE contacts ADD COLUMN updated_at INTEGER;

-- ===================================================================
-- STEP 3: ADD TRIGGERS
-- ===================================================================

-- Delete protection trigger for chats
DROP TRIGGER IF EXISTS trg_no_delete_chats;
CREATE TRIGGER trg_no_delete_chats
    BEFORE DELETE ON chats
    BEGIN
      SELECT CASE
        WHEN EXISTS(
          SELECT 1 FROM delete_guard
          WHERE tenant_id=OLD.tenant_id
            AND jid=OLD.jid
            AND (until_ts IS NULL OR until_ts > CAST(strftime('%s','now') AS INTEGER))
        )
        THEN NULL
        ELSE RAISE(ABORT, 'Chat history delete is disabled')
      END;
    END;

-- ===================================================================
-- STEP 4: OPTIONAL TABLES (Uncomment if needed)
-- ===================================================================

-- Knowledge Base Files (Advanced version - uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS kb_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    filename TEXT,
    title TEXT,
    file_kind TEXT,
    uploaded_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    chunk_index INTEGER,
    text TEXT,
    tokens INTEGER,
    embedding TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (file_id) REFERENCES kb_files(id)
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant ON kb_chunks(tenant_id);
*/

-- Calendar Events (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    external_id TEXT,
    event_id TEXT,
    status TEXT,
    payload_json TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    UNIQUE(tenant_id, external_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_cal_events_tenant_jid ON calendar_events(tenant_id, jid);
*/

-- AI Media Management (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS ai_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    title TEXT,
    kind TEXT,
    file TEXT,
    lang TEXT,
    caption_default TEXT,
    rule_prompt TEXT,
    priority INTEGER DEFAULT 100,
    enabled INTEGER DEFAULT 1,
    once_per_chat INTEGER DEFAULT 0,
    cooldown_sec INTEGER DEFAULT 0,
    tags TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS ai_media_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    media_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    ts INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (media_id) REFERENCES ai_media(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_media_tenant ON ai_media(tenant_id, enabled, priority);
CREATE INDEX IF NOT EXISTS idx_ai_media_sends ON ai_media_sends(tenant_id, media_id, acc_id, jid, ts);
*/

-- Product Catalog (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS products (
    id_1c TEXT PRIMARY KEY,
    sku TEXT,
    name TEXT,
    description TEXT,
    category TEXT,
    image_url TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS prices (
    id_1c TEXT PRIMARY KEY,
    price REAL,
    currency TEXT,
    stock INTEGER,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_1c TEXT,
    url TEXT,
    sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prodimgs_id1c ON product_images(id_1c, sort_order);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
*/

-- Voice Synthesis (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    name TEXT,
    lang TEXT,
    status TEXT,
    seconds_total INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_voices_tenant ON voices(tenant_id);
*/

-- First Message Queue (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS firstmsg_state (
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    state TEXT,
    created_ts INTEGER,
    sent_ts INTEGER,
    done_ts INTEGER,
    PRIMARY KEY(tenant_id, acc_id, jid),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS firstmsg_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    due_ts INTEGER,
    status TEXT,
    text TEXT,
    media_file TEXT,
    media_kind TEXT,
    created_ts INTEGER,
    sent_ts INTEGER,
    attempts INTEGER DEFAULT 0,
    last_try_ts INTEGER DEFAULT 0,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (acc_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_firstmsg_jobs_due ON firstmsg_jobs(status, due_ts);
*/

-- Admin Notifications (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    image_file TEXT,
    target_all INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_notification_targets (
    notif_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (notif_id, user_id),
    FOREIGN KEY (notif_id) REFERENCES admin_notifications(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_notification_views (
    notif_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    seen_at INTEGER,
    PRIMARY KEY (notif_id, user_id),
    FOREIGN KEY (notif_id) REFERENCES admin_notifications(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_active ON admin_notifications(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_notif_targets_user ON admin_notification_targets(user_id, notif_id);
CREATE INDEX IF NOT EXISTS idx_admin_notif_views_user ON admin_notification_views(user_id, notif_id);
*/

-- Tariff Plans (Uncomment if needed)
/*
CREATE TABLE IF NOT EXISTS tariff_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    price_kzt INTEGER DEFAULT 0,
    wa_max INTEGER DEFAULT 10,
    tg_max INTEGER DEFAULT 999,
    feature_mask INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
*/

-- ===================================================================
-- COMMIT TRANSACTION
-- ===================================================================

COMMIT;

-- ===================================================================
-- VERIFICATION QUERIES (Run these after migration)
-- ===================================================================

-- Check if all critical tables exist
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- Check users table structure
-- PRAGMA table_info(users);

-- Check accounts table structure
-- PRAGMA table_info(accounts);

-- Check chats table structure
-- PRAGMA table_info(chats);

-- Check all indexes
-- SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name;

-- Check all triggers
-- SELECT name, tbl_name FROM sqlite_master WHERE type='trigger';
