// index.js — NeDzat SaaS (multi-tenant)
// -------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const AdmZip   = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const iconv    = require('iconv-lite');
const fsp = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const OpenAI = require('openai');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const WABAClient = require('./waba.js');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors    = require('cors');
const multer  = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } = require('jose');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const CRM_FUNCTIONS_BASE = 'https://sejeygmlpgseyutuvfhk.supabase.co/functions/v1';
const axios = require('axios');
// ===============================
// GUPSHUP (Partner Portal) helpers
// ===============================
const GUP_BASE = process.env.GUPSHUP_PARTNER_BASE || 'https://partner.gupshup.io';

let _gupPartnerToken = null;
let _gupPartnerTokenExp = 0;

async function gupGetPartnerToken() {
  const now = Date.now();
  if (_gupPartnerToken && now < _gupPartnerTokenExp) return _gupPartnerToken;

  const email = process.env.GUPSHUP_PARTNER_EMAIL;
  const password = process.env.GUPSHUP_PARTNER_SECRET; // client secret / password
  if (!email || !password) throw new Error('Missing GUPSHUP_PARTNER_EMAIL / GUPSHUP_PARTNER_SECRET');

  const resp = await axios.post(`${GUP_BASE}/partner/account/login`, { email, password }, { timeout: 20000 });
  const tok = resp.data?.token || resp.data?.jwt || resp.data?.access_token || resp.data?.data?.token;
  if (!tok) throw new Error('Gupshup partner token not found in response');

  _gupPartnerToken = tok;
  _gupPartnerTokenExp = now + 50 * 60 * 1000;
  return tok;
}

async function gupCreateApp(appName) {
  const token = await gupGetPartnerToken();
  const resp = await axios.post(`${GUP_BASE}/partner/app`, { name: appName }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });
  const appId = resp.data?.appId || resp.data?.id || resp.data?.data?.appId;
  if (!appId) throw new Error('appId not found after create app');
  return appId;
}

async function gupGetEmbedLink(appId) {
  const token = await gupGetPartnerToken();
  const resp = await axios.get(`${GUP_BASE}/partner/app/${appId}/onboarding/embed/link`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });
  const url = resp.data?.url || resp.data?.link || resp.data?.data?.url || resp.data?.data?.link;
  if (!url) throw new Error('embed link not found in response');
  return url;
}

async function gupGetAppToken(appId) {
  const token = await gupGetPartnerToken();
  const resp = await axios.get(`${GUP_BASE}/partner/app/${appId}/token`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });
  const t = resp.data?.token || resp.data?.access_token || resp.data?.data?.token;
  if (!t) throw new Error('app token not found in response');
  return t;
}

async function gupSubscribeV3(appId, webhookUrl) {
  const token = await gupGetPartnerToken();
  // если получишь 400 — надо будет подогнать body под их текущую схему
  const resp = await axios.post(`${GUP_BASE}/partner/app/${appId}/subscription`, {
    url: webhookUrl,
    version: 'v3'
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });
  return resp.data;
}

// --- Analytics deps (optional) ---
let geoip = null;
let UAParser = null;
try { geoip = require('geoip-lite'); } catch(_){}
try { UAParser = require('ua-parser-js'); } catch(_){}

// -------------------------------------------------
// App / Server / IO
// -------------------------------------------------
const app    = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.set('trust proxy', 1);

app.get('/.well-known/apple-developer-domain-association', (req, res) => {
  const p = path.join(__dirname, 'public', '.well-known', 'apple-developer-domain-association');
  return res.sendFile(p);
});

// --- NO-CACHE for HTML/auth to avoid "white page until Ctrl+F5"
app.use((req, res, next) => {
  const p = req.path || '';
  const isHtml = (p === '/' || p.endsWith('.html'));
  const isAuth = p.startsWith('/api/auth/') || p.startsWith('/api/oauth/') || p.includes('/callback');

  if (isHtml || isAuth) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use('/public', express.static(path.join(__dirname, 'panel')));
const server = http.createServer(app);
process.on('unhandledRejection', (e) => { console.error('[UNHANDLED REJECTION]', e?.stack || e); });
process.on('uncaughtException', (e) => { console.error('[UNCAUGHT EXCEPTION]', e?.stack || e); setTimeout(() => process.exit(1), 500); });
// === CORS origins helper (добавляем домены из ENV) ===
function getCorsOrigins() {
  const def = ['http://localhost:3099', 'http://194.32.141.216:3099'];
  const extra = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...def, ...extra]));
}
const io = new Server(server, { cors: { origin: getCorsOrigins(), credentials: true, } });
app.use(cors({ origin: getCorsOrigins(), credentials: true, }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // нужно для Apple form_post callback
app.use(cookieParser());

// --- Analytics: stable visitor id cookie (aid) ---
app.use((req, res, next) => {
  try {
    const has = req.cookies && req.cookies.aid;
    if (!has) {
      const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
      const aid = crypto.randomBytes(12).toString('hex'); // 24 chars
      res.cookie('aid', aid, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: 90 * 24 * 3600 * 1000
      });
      // чтобы в этом же запросе aid был доступен
      req.cookies = req.cookies || {};
      req.cookies.aid = aid;
    }
  } catch(_) {}
  next();
});

app.use(express.static(path.join(__dirname, 'panel')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
(async ()=>{ try { await fsp.mkdir(UPLOAD_DIR, {recursive:true}); } catch(_){}})();
app.use('/uploads', express.static(UPLOAD_DIR));

// avatars
const AVATAR_ROOT = path.join(UPLOAD_DIR, 'avatars');
(async ()=>{ try { await fsp.mkdir(AVATAR_ROOT, { recursive:true }); } catch(_){}})();
// brand logo
const BRAND_ROOT = path.join(UPLOAD_DIR, 'brand');
(async ()=>{ try { await fsp.mkdir(BRAND_ROOT, { recursive:true }); } catch(_){}})();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://194.32.141.216:3099').replace(/\/+$/,'');

// ---------------- Instagram (Meta) ----------------
const IG_APP_ID       = process.env.IG_APP_ID || '';
const IG_APP_SECRET   = process.env.IG_APP_SECRET || '';
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || ''; // любая секретная строка

function igAssertEnv(){
  if(!IG_APP_ID || !IG_APP_SECRET || !IG_VERIFY_TOKEN){
    throw new Error('IG env missing: IG_APP_ID / IG_APP_SECRET / IG_VERIFY_TOKEN');
  }
}

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const APPLE_CLIENT_ID  = process.env.APPLE_CLIENT_ID || '';
const APPLE_TEAM_ID    = process.env.APPLE_TEAM_ID || '';
const APPLE_KEY_ID     = process.env.APPLE_KEY_ID || '';
const APPLE_PRIVATE_KEY_PATH = process.env.APPLE_PRIVATE_KEY_PATH || '';

let APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!APPLE_PRIVATE_KEY && APPLE_PRIVATE_KEY_PATH) {
  try {
    APPLE_PRIVATE_KEY = fs.readFileSync(APPLE_PRIVATE_KEY_PATH, 'utf8');
  } catch (e) {
    console.error('[APPLE_OAUTH] cannot read APPLE_PRIVATE_KEY_PATH:', e?.message || e);
  }
}

APPLE_PRIVATE_KEY = String(APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

// если ключ положили в ENV одной строкой с \n
APPLE_PRIVATE_KEY = String(APPLE_PRIVATE_KEY).replace(/\r/g, '').replace(/\\n/g, '\n');

// -------------------------------------------------
// Email verification helpers
// -------------------------------------------------
function isAutoVerifiedEmail(email){
  const e = String(email||'').trim().toLowerCase();
  return e.endsWith('@deshti.kz') || e.endsWith('@satubooster.kz');
}

function sha256hex(s){
  return crypto.createHash('sha256').update(String(s||'')).digest('hex');
}

function setAuthCookie(res, req, token){
  const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
  res.cookie('token', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000
  });
}

function setTempCookie(res, req, name, value, maxAgeMs = 10 * 60 * 1000, opt = {}){
  const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
  const sameSite = opt.sameSite || 'lax';

  // Важно: sameSite:'none' требует secure:true
  const secure = (sameSite === 'none') ? true : isSecure;

  res.cookie(name, value, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: maxAgeMs
  });
}

function getGoogleClient(){
  const redirectUri = `${getPublicBaseUrl()}/api/auth/google/callback`;
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

// Apple client_secret (JWT) — Sign in with Apple требует JWT, подписанный ES256
let _appleSecretCache = { value: null, exp: 0 };
async function getAppleClientSecret(){
  if(!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) return '';
  const now = Math.floor(Date.now() / 1000);

  if (_appleSecretCache.value && now < (_appleSecretCache.exp - 30)) {
    return _appleSecretCache.value;
  }

  const pk = await importPKCS8(APPLE_PRIVATE_KEY, 'ES256');
  const exp = now + 6 * 60; // 6 минут (можно больше, но так безопаснее)

  const jwtStr = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APPLE_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setSubject(APPLE_CLIENT_ID)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(pk);

  _appleSecretCache = { value: jwtStr, exp };
  return jwtStr;
}

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

async function createTenantAndUserForOAuth({ email, provider, sub, name, picture }){
  // open_signup check — как у register_public
  const enabled = (await getSetting('open_signup', 1) || '0') === '1';
  if(!enabled){
    const e = new Error('open_signup disabled');
    e.code = 'SIGNUP_DISABLED';
    throw e;
  }

  const role = (await getSetting('open_signup_role', 1) || 'user');

  const local = (email.split('@')[0] || 'user').replace(/[^a-z0-9_-]/gi,'').slice(0,24);
  const uniqueSuffix = Math.random().toString(36).slice(2,8);
  const tenantName = `${local || 'user'}-${uniqueSuffix}`;

  const tIns = await run(`INSERT INTO tenants(name,created_at) VALUES(?,?)`, [tenantName, Date.now()]);
  const tid = tIns.lastID;

  await seedDefaultsForTenant(tid);

  const col = (provider === 'google') ? 'google_sub' : 'apple_sub';

  const uIns = await run(
    `INSERT INTO users(tenant_id,email,pass_hash,role,created_at,email_verified,${col},oauth_name,oauth_picture)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [tid, email, null, role, Date.now(), 1, sub, name || null, picture || null]
  );

  return await get(`SELECT * FROM users WHERE id=?`, [uIns.lastID]);
}

async function findOrCreateOAuthUser({ provider, sub, email, name, picture }){
  if(!sub) throw new Error('no sub');

  if (provider === 'google'){
    const u1 = await get(`SELECT * FROM users WHERE google_sub=?`, [sub]);
    if (u1) return u1;

    if (email){
      const u2 = await get(`SELECT * FROM users WHERE email=?`, [email]);
      if (u2){
        await run(
          `UPDATE users
             SET google_sub=?,
                 oauth_name=COALESCE(oauth_name, ?),
                 oauth_picture=COALESCE(oauth_picture, ?),
                 email_verified=1
           WHERE id=?`,
          [sub, name || null, picture || null, u2.id]
        );
        return await get(`SELECT * FROM users WHERE id=?`, [u2.id]);
      }
    }
  }

  if (provider === 'apple'){
    const u1 = await get(`SELECT * FROM users WHERE apple_sub=?`, [sub]);
    if (u1) return u1;

    if (email){
      const u2 = await get(`SELECT * FROM users WHERE email=?`, [email]);
      if (u2){
        await run(
          `UPDATE users
             SET apple_sub=?,
                 oauth_name=COALESCE(oauth_name, ?),
                 oauth_picture=COALESCE(oauth_picture, ?),
                 email_verified=1
           WHERE id=?`,
          [sub, name || null, picture || null, u2.id]
        );
        return await get(`SELECT * FROM users WHERE id=?`, [u2.id]);
      }
    }
  }

  if(!email){
    const e = new Error('email is required for first sign-in');
    e.code = 'NO_EMAIL';
    throw e;
  }

  return await createTenantAndUserForOAuth({ email, provider, sub, name, picture });
}

let _mailer = null;
function getMailer(){
  if (_mailer) return _mailer;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  const secure = String(process.env.SMTP_SECURE || '').trim() === '1' || String(process.env.SMTP_SECURE||'').toLowerCase() === 'true';
  const tlsReject = String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '1').trim() !== '0';

  _mailer = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: tlsReject }
  });

  return _mailer;
}

async function sendVerifyEmail(toEmail, token){
  const mailer = getMailer();
  if (!mailer) return { ok:false, error:'smtp_not_configured' };

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const link = `${PUBLIC_BASE_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;

  const subject = 'Подтверждение почты';
  const text = `Здравствуйте!\n\nПодтвердите почту по ссылке:\n${link}\n\nЕсли это не вы — просто игнорируйте письмо.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Подтверждение почты</h2>
      <p>Нажмите кнопку, чтобы подтвердить email:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0ea5e9;color:#fff;text-decoration:none">Подтвердить почту</a></p>
      <p style="color:#64748b;font-size:12px">Если это не вы — игнорируйте письмо.</p>
    </div>
  `;

  await mailer.sendMail({ from, to: toEmail, subject, text, html });
  return { ok:true };
}

async function sendResetEmail(toEmail, token){
  const mailer = getMailer();
  if (!mailer) return { ok:false, error:'smtp_not_configured' };

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  // login.html у тебя доступен и по /login.html и по /public/login.html, но проще так:
  const link = `${PUBLIC_BASE_URL}/login.html#reset=${encodeURIComponent(token)}`;

  const subject = 'Сброс пароля';
  const text = `Здравствуйте!\n\nСброс пароля по ссылке:\n${link}\n\nЕсли это не вы — просто игнорируйте письмо.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Сброс пароля</h2>
      <p>Нажмите кнопку, чтобы задать новый пароль:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0ea5e9;color:#fff;text-decoration:none">Сбросить пароль</a></p>
      <p style="color:#64748b;font-size:12px">Если это не вы — игнорируйте письмо.</p>
    </div>
  `;

  await mailer.sendMail({ from, to: toEmail, subject, text, html });
  return { ok:true };
}

// -------------------------------------------------
// Helpers
// -------------------------------------------------
const nowSec = () => Math.floor(Date.now()/1000);
function startOfUTCDay(tsSec){ const d=new Date(tsSec*1000); d.setUTCHours(0,0,0,0); return Math.floor(d.getTime()/1000); }
function includesPhrase(text, arr){ const t=String(text||'').toLowerCase(); return (Array.isArray(arr)?arr:[]).some(p=> t.includes(String(p).toLowerCase())); }

async function fileToDataURL(absPath, mime='application/octet-stream'){
  const buf = await fsp.readFile(absPath);
  const b64 = buf.toString('base64');
  return `data:${mime};base64,${b64}`;
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function sleepCoop(ms, shouldCancel) {
  const step = 500; // 0.5s шаг
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await shouldCancel()) return true;  // отменяем сон
    await sleep(Math.min(step, end - Date.now()));
  }
  return false;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function makeHeartbeat(campaign_id) {
  let lastBeat = 0;
  return async () => {
    const t = Date.now();
    if (t - lastBeat >= 10_000) {
      await run(`UPDATE campaigns SET processing_ts=? WHERE id=?`, [t, campaign_id]);
      lastBeat = t;
    }
  };
}

async function authGuard(req,res,next){
  try{
    const tok = req.cookies?.token || (req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!tok) return res.status(401).json({ok:false,error:'unauthorized'});

    const p = jwt.verify(tok, JWT_SECRET);

    // блокировка аккаунта (доступ к API закрываем полностью)
    try{
      const row = await get(`SELECT disabled FROM users WHERE id=?`, [p.uid]);
      if (row && Number(row.disabled || 0) === 1){
        res.clearCookie('token', { path:'/' });
        return res.status(403).json({ ok:false, error:'account_disabled' });
      }
    }catch(_){}

    req.user = { id:p.uid, tenant_id:p.tid, role:p.role, email:p.email };
    next();
  }catch(e){
    return res.status(401).json({ok:false,error:'unauthorized'});
  }
}
function adminOnly(req,res,next){
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok:false, error:'forbidden' });
  }
  next();
}
function optAuth(req,res,next){
  try{
    const tok = req.cookies?.token || (req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(tok){ const p=jwt.verify(tok, JWT_SECRET); req.user={ id:p.uid, tenant_id:p.tid, role:p.role, email:p.email }; }
  }catch(_){}
  next();
}

function getPublicBaseUrl() {
  return PUBLIC_BASE_URL; // всегда одно и то же, без завершающего /
}

async function getEmbedding(openaiKey, text){
  const openai = new OpenAI({ apiKey: openaiKey });
  // компактная и недорогая модель эмбеддингов
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return resp.data?.[0]?.embedding || [];
}

function roughTokenCount(s){ // грубая оценка токенов
  return Math.ceil(String(s||'').length / 4);
}

// --- SatuCoin: вспомогательные функции ---
// 1 лид (уникальный номер клиента в месяц) = N SatuCoin
const SATU_DEFAULT_PRICE_PER_LEAD = Number(process.env.SATU_PRICE_PER_LEAD || 30);

// --- SatuCoin TX mutex (чтобы не было nested BEGIN) ---
let _satuTxChain = Promise.resolve();

async function satuTxLock() {
  let unlock;
  const gate = new Promise(res => (unlock = res));
  const prev = _satuTxChain;
  _satuTxChain = prev.then(() => gate);
  await prev;
  return unlock;
}

/**
 * month_key: '2025-12'
 */
function getMonthKey(tsMs = Date.now()) {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

async function isLeadPaidThisMonth({ tenantId, accId, jid, tsMs = Date.now() }) {
  const monthKey = getMonthKey(tsMs);
  const row = await get(
    `SELECT 1 FROM satu_leads WHERE tenant_id=? AND acc_id=? AND jid=? AND month_key=?`,
    [tenantId, accId, jid, monthKey]
  );
  return !!row;
}

async function getSatuBalance(tenantId) {
  const row = await get(
    `SELECT balance FROM satu_wallets WHERE tenant_id=?`,
    [tenantId]
  );
  return row ? row.balance : 0;
}

async function changeSatuBalance(tenantId, delta, {
  userId = null,
  reason = '',
  meta = {}
} = {}) {
  const now = Date.now();
  const d = Number(delta);

  if (!Number.isFinite(d) || d === 0) {
    return await getSatuBalance(tenantId);
  }

  if (d < 0) {
    const cur = Number(await getSatuBalance(tenantId) || 0);
    if (cur + d < 0) {
      const err = new Error('SATU_NO_FUNDS');
      err.code = 'SATU_NO_FUNDS';
      throw err;
    }
  }

  await run(`
    INSERT INTO satu_wallets(tenant_id, balance, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      balance = balance + excluded.balance,
      updated_at = excluded.updated_at
  `, [tenantId, d, now]);

  await run(`
    INSERT INTO satu_transactions(tenant_id, user_id, amount, reason, meta, created_at)
    VALUES(?,?,?,?,?,?)
  `, [
    tenantId,
    userId,
    d,
    reason || '',
    JSON.stringify(meta || {}),
    now
  ]);

  return await getSatuBalance(tenantId);
}

/**
 * Получаем цену за 1 лид для конкретного tenant-а.
 * Если настроек нет, берём дефолт.
 */
async function getSatuPricePerLead(tenantId) {
  const raw = await getSetting('satu_price_per_lead', tenantId); // может быть null
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return SATU_DEFAULT_PRICE_PER_LEAD;
}

/**
 * Проверяем, что баланс >= цене за лид.
 * Если нет – кидаем ошибку SATU_NO_FUNDS.
 * Это именно "гейт" — чтобы при нуле вообще ничто из ИИ не работало.
 */
async function ensureSatuEnoughForChat(tenantId) {
  const price = await getSatuPricePerLead(tenantId);
  const balance = await getSatuBalance(tenantId);

  if (balance < price) {
    const err = new Error('SatuCoin balance is zero or not enough');
    err.code = 'SATU_NO_FUNDS';
    throw err;
  }

  return { balance, price };
}

/**
 * Списываем за лид, если в этом месяце ещё не списывали.
 * tenantId + accId + jid + month_key — уникальный ключ.
 */
async function chargeSatuForLeadIfNeeded({ tenantId, accId, jid, userId = null }) {

  const unlock = await satuTxLock();

  try {
  
  const ts = Date.now();
  const monthKey = getMonthKey(ts);

  await run('BEGIN IMMEDIATE');
  try {
    const ins = await run(
      `INSERT INTO satu_leads(tenant_id, acc_id, jid, month_key, first_ts)
       VALUES(?,?,?,?,?)
       ON CONFLICT(tenant_id, acc_id, jid, month_key) DO NOTHING`,
      [tenantId, accId, jid, monthKey, ts]
    );

    if (!ins || ins.changes === 0) {
      await run('COMMIT');
      return;
    }

    const price = await getSatuPricePerLead(tenantId);

    const row = await get(`SELECT balance FROM satu_wallets WHERE tenant_id=?`, [tenantId]);
    const bal = row ? Number(row.balance || 0) : 0;
    if (bal < price) {
      const err = new Error('SATU_NO_FUNDS');
      err.code = 'SATU_NO_FUNDS';
      throw err;
    }

    await changeSatuBalance(tenantId, -price, {
      userId,
      reason: 'lead_month',
      meta: { acc_id: accId, jid, month: monthKey }
    });

    await run('COMMIT');
  } catch (e) {
    try { await run('ROLLBACK'); } catch(_) {}
    throw e;
  }
  } finally {
    try { unlock(); } catch(_) {}
  }
}

// режем текст на куски ~800–1000 токенов (по ~3500–4000 символов)
function chunkText(str, maxChars = 3800){
  const s = String(str||'').replace(/\r/g,'').trim();
  const out = [];
  let i = 0;
  while (i < s.length){
    let end = Math.min(i + maxChars, s.length);
    if (end < s.length){
      const slice = s.slice(i, end);
      // стараемся резать по границам
      let cut = slice.lastIndexOf('\n\n');
      if (cut < maxChars * 0.5) cut = Math.max(cut, slice.lastIndexOf('. '));
      if (cut < maxChars * 0.5) cut = Math.max(cut, slice.lastIndexOf(' '));
      if (cut >= maxChars * 0.5) end = i + cut + 1;
    }
    const part = s.slice(i, end).trim();
    if (part) out.push(part);
    i = end;
  }
  return out;
}

function htmlToText(html){
  let s = String(html||'');

  // убираем script/style
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  // переносы строк для блоков
  s = s.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(p|div|h[1-6]|li|section|article|tr|table)>/gi, '$&\n');

  // убираем остальные теги
  s = s.replace(/<[^>]+>/g, ' ');

  // простая декодировка html-сущностей
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/gi, "'");

  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function flattenChatGptExport(exportJson){
  const arr = Array.isArray(exportJson) ? exportJson : [];
  const out = [];

  for (const conv of arr){
    if (!conv) continue;

    const title   = String(conv.title || 'Без названия').trim();
    const created = conv.create_time ? new Date(conv.create_time * 1000) : null;

    const headerParts = ['==== Диалог: ' + title];
    if (created){
      headerParts.push('(' + created.toLocaleString('ru-RU') + ')');
    }
    out.push(headerParts.join(' ') + ' ====');

    const mapping = conv.mapping || {};
    const nodes = Object.values(mapping)
      .filter(n => n && n.message && n.message.content)
      .sort((a,b)=>{
        const ta = (a.message && a.message.create_time) ? a.message.create_time : 0;
        const tb = (b.message && b.message.create_time) ? b.message.create_time : 0;
        return ta - tb;
      });

    for (const node of nodes){
      const m = node.message;
      if (!m) continue;

      const ts = m.create_time
        ? new Date(m.create_time * 1000).toLocaleString('ru-RU')
        : '';

      let role = (m.author && m.author.role) ? m.author.role : 'unknown';
      if (role === 'assistant') role = 'ChatGPT';
      else if (role === 'user') role = 'Пользователь';
      else if (role === 'system') role = 'Система';

      let text = '';
      const c = m.content;
      if (c){
        if (Array.isArray(c.parts)){
          text = c.parts.join('\n');
        } else if (typeof c === 'string'){
          text = c;
        } else if (c.text){
          text = c.text;
        }
      }
      if (!String(text || '').trim()) continue;

      out.push((ts ? '[' + ts + '] ' : '') + role + ':\n' + text + '\n');
    }

    out.push('');
  }

  return out.join('\n');
}

const pdfParse = require('pdf-parse');
let officeParser = null;
try {
  officeParser = require('officeparser');
} catch (e) {
  console.warn('officeparser not installed, DOCX/PPTX KB ingest disabled:', e.message);
}
const { execFile } = require('child_process');

/** Рендерит первую страницу PDF в PNG, возвращает путь к PNG (или null) */
async function pdfFirstPageToPng(absPdfPath){
  return new Promise((resolve) => {
    try{
      const outBase = path.join(UPLOAD_DIR, path.basename(absPdfPath, '.pdf') + '-p1');
      execFile('pdftoppm', ['-png', '-singlefile', '-f', '1', '-l', '1', absPdfPath, outBase], { timeout: 15000 }, (err)=>{
        if (err) return resolve(null);
        const pngPath = outBase + '.png';
        fs.access(pngPath, fs.constants.R_OK, (e)=> resolve(e ? null : pngPath));
      });
    }catch(_){ resolve(null); }
  });
}

/** Достаёт кадр из видео в JPG (первую секунду), возвращает путь к JPG или null */
async function videoFirstFrameToJpg(absVideoPath){
  return new Promise((resolve) => {
    try{
      const outJpg = path.join(UPLOAD_DIR, path.basename(absVideoPath).replace(/\.[^.]+$/i,'') + '-frame1.jpg');
      execFile(process.env.FFMPEG_BIN || 'ffmpeg',
        ['-y','-hide_banner','-loglevel','error','-ss','00:00:01','-i', absVideoPath, '-frames:v','1','-q:v','2', outJpg],
        { timeout: 15000 },
        (err)=>{
          if (err) return resolve(null);
          fs.access(outJpg, fs.constants.R_OK, (e)=> resolve(e ? null : outJpg));
        }
      );
    } catch(_) { resolve(null); }
  });
}

function clampText(s, maxChars = 4000) {
  s = String(s || '').replace(/\u0000/g, '').trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function xlsxToText(absXlsx, maxSheets = 3, maxRows = 60, maxCols = 20) {
  const wb = XLSX.readFile(absXlsx, { cellDates: true });
  const out = [];
  const sheetNames = (wb.SheetNames || []).slice(0, maxSheets);

  for (const sn of sheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    out.push(`--- Sheet: ${sn} ---`);
    for (let r = 0; r < Math.min(rows.length, maxRows); r++) {
      const row = rows[r] || [];
      const cells = row.slice(0, maxCols).map(v => String(v ?? '').trim());
      if (cells.join('').length) out.push(cells.join('\t'));
    }
    out.push('');
  }
  return out.join('\n').trim();
}

async function extractOfficeText(absPath, fileName) {
  const ext = path.extname(String(fileName || absPath)).toLowerCase();
  const st = await fsp.stat(absPath).catch(() => null);
  if (!st) return '';

  // чтобы не убить процесс на больших файлах
  if (st.size > 25 * 1024 * 1024) return ''; // >25MB — пропускаем извлечение

  if (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.log') {
    return (await fsp.readFile(absPath, 'utf8').catch(() => '')).trim();
  }

  if (ext === '.xlsx' || ext === '.xls') {
    try { return xlsxToText(absPath); } catch (_) { return ''; }
  }

  if (ext === '.docx' || ext === '.pptx') {
    if (!officeParser) return '';
    try {
      if (officeParser.parseOfficeAsync) return String(await officeParser.parseOfficeAsync(absPath) || '').trim();
      if (officeParser.parseOffice) {
        const t = await new Promise((resolve, reject) =>
          officeParser.parseOffice(absPath, (err, text) => err ? reject(err) : resolve(text))
        );
        return String(t || '').trim();
      }
      if (ext === '.docx' && officeParser.parseDocx) {
        const t = await new Promise((resolve, reject) =>
          officeParser.parseDocx(absPath, (err, text) => err ? reject(err) : resolve(text))
        );
        return String(t || '').trim();
      }
    } catch (_) { return ''; }
  }

  return '';
}

async function extractPdfText(absPdfPath, openaiKey) {
  let pdfText = '';

  // 1) pdf-parse
  try {
    const buf = await fsp.readFile(absPdfPath);
    const parsed = await pdfParse(buf);
    pdfText = String(parsed?.text || '').trim();
  } catch (_) {}

  // 2) OCR fallback (1 page) через vision
  if ((!pdfText || pdfText.replace(/\s+/g, '').length < 20) && openaiKey) {
    try {
      const png = await pdfFirstPageToPng(absPdfPath);
      if (png) {
        const openai = new OpenAI({ apiKey: openaiKey });
        const dataURL = await fileToDataURL(png, 'image/png');
        const comp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Извлеки текст из PDF (OCR) и кратко опиши содержание. Дай краткий связный текст (не JSON).' },
              { type: 'image_url', image_url: { url: dataURL } }
            ]
          }]
        });
        const v = String(comp.choices?.[0]?.message?.content || '').trim();
        if (v) pdfText = v;
      }
    } catch (_) {}
  }

  return pdfText.trim();
}

const os = require('os');

// Универсальный транскод в OGG/Opus (для WhatsApp/iPhone)
async function transcodeToOpusOgg(inPath) {
  return new Promise((resolve, reject) => {
    const outPath = inPath.replace(/\.[^.]+$/i, '') + '.ogg';
    execFile(
      process.env.FFMPEG_BIN || 'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', inPath,
        '-map', '0:a:0',
        '-vn',
        '-ac', '1',          // моно
        '-ar', '16000',      // 16 кHz — максимально совместимо для voice
        '-c:a', 'libopus',
        '-b:a', '24k',
        '-application', 'voip',
        '-f', 'ogg',
        outPath
      ],
      { timeout: 40000 },
      (err) => err ? reject(err) : resolve(outPath)
    );
  });
}

/** Нормализуем аудио под WhatsApp/iPhone. Возвращаем { abs, mime, ptt }. */
async function normalizeAudioForWA(absPath){
  // Для надёжности всё гоняем через единый профиль OGG/Opus 16k моно
  // (это устраивает iOS-клиент WhatsApp и помечаем как PTT).
  try {
    const ogg = await transcodeToOpusOgg(absPath);
    return { abs: ogg, mime: 'audio/ogg; codecs=opus', ptt: true };
  } catch (err) {
    console.warn('[AUDIO] transcode failed, using original:', err?.message || err);
    // Fallback: отправляем оригинальный файл без конвертации
    const ext = path.extname(absPath).toLowerCase();
    const mime = ext === '.webm' ? 'audio/webm' :
                 ext === '.ogg' ? 'audio/ogg' :
                 ext === '.mp3' ? 'audio/mpeg' :
                 ext === '.m4a' ? 'audio/mp4' :
                 'audio/ogg';
    return { abs: absPath, mime, ptt: true };
  }
}

// Делаем превью-копию для CRM (играет везде, в т.ч. iOS Safari)
async function makePreviewM4A(inPath) {
  return new Promise((resolve, reject) => {
    const outPath = inPath.replace(/\.[^.]+$/i, '') + '.m4a';
    execFile(
      process.env.FFMPEG_BIN || 'ffmpeg',
      [
        '-y','-hide_banner','-loglevel','error',
        '-i', inPath,
        '-map','0:a:0',
        '-vn',
        '-ac','1',
        '-ar','44100',
        '-c:a','aac',
        '-b:a','64k',
        '-movflags','+faststart',
        outPath
        ],
      { timeout: 40000 },
      (err) => err ? reject(err) : resolve(outPath)
    );
  });
}

// --- SAFETY WRAPPERS & ASR FALLBACKS (вставить после makePreviewM4A) ---
async function safeMakePreviewM4A(inPath) {
  try {
    return await makePreviewM4A(inPath);
  } catch (e) {
    console.warn('[FFMPEG][m4a] fail, use original:', e?.message || e);
    return inPath; // fallback: без превью
  }
}

async function transcribeWithFallback(absPath, openaiKey) {
  const openai = new OpenAI({ apiKey: openaiKey });

  // Попытка №1: как есть
  try {
    const r1 = await openai.audio.transcriptions.create({
      file: fs.createReadStream(absPath),
      model: 'whisper-1',
      response_format: 'text',
      temperature: 0
    });
    const t1 = String(r1 || '').trim();
    if (t1) return t1;
  } catch (e) {
    console.warn('[ASR] whisper-1 fail:', e?.message || e);
  }

  // Попытка №2: перегоняем во WAV 16k mono и ещё раз
  try {
    const tmpWav = absPath.replace(/\.[^.]+$/i, '') + '.wav';
    await new Promise((res, rej) => {
      execFile(process.env.FFMPEG_BIN || 'ffmpeg',
        ['-y','-hide_banner','-loglevel','error','-i', absPath, '-ac','1','-ar','16000', tmpWav],
        { timeout: 30000 },
        (err)=> err?rej(err):res()
      );
    });
    const r2 = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpWav),
      model: 'whisper-1',
      response_format: 'text',
      temperature: 0
    });
    const t2 = String(r2 || '').trim();
    if (t2) return t2;
  } catch (e) {
    console.warn('[ASR] fallback wav fail:', e?.message || e);
  }

  return '';
}

function parseReceiptAmount(raw) {
  const src = String(raw || '').replace(/\s+\n/g, '\n').trim();
  if (!src) return null;

  // 1) вычистим явные «не деньги»
  let text = src
    .replace(/\bKZ\d{18}\b/gi, ' ')                  // IBAN
    .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, ' ')    // номера карт
    .replace(/\b\d{9,}\b/g, ' ')                     // длинные коды/номера
    .replace(/\b7\d{10}\b/g, ' ').replace(/\b8\d{10}\b/g, ' ') // телефоны
    .trim();

  // 2) карты слов
  const currencyMap = {
    'KZT': ['₸','KZT','тг','тенге','тнг']
  };
  const curRegex = Object.values(currencyMap).flat().map(x => x.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')).join('|');

  // 3) ключевые слова рядом с итогом
  // ru/kk/en
  const kwCore = [
    // RU
    'итого(?:вая)?','всего','к\\s*оплате','оплата','сумма','списано','переведено',
    // EN
    'total(?:\\s*amount)?','amount(?:\\s*paid)?','paid','grand\\s*total','transfer\\s*(?:amount|completed|successful|successfully)',
    // KK
    'жалпы','барлығы','төлем','аударым(?:\\s*сомасы)?','сәтті\\s*аударылды','сомасы','жөнелтілді'
  ];
  const kw = `(?:${kwCore.join('|')})`;

  // 4) строки-комиссии (исключаем из кандидатов)
  const feeRx = /\b(комисси(?:я|ясы)|commission\s*fee|fee|қызмет\s*ақысы|service\s*fee)\b/i;

  // 5) нормализатор числа
  const toNumber = (s) => {
    if (!s) return NaN;
    const raw = String(s).replace(/\s+/g,'');
    if (/,\d{1,2}$/.test(raw) && /\./.test(raw)) return parseFloat(raw.replace(/,/g,''));                 // 1,234.56
    if (/\.\d{1,2}$/.test(raw) && /,/.test(raw)) return parseFloat(raw.replace(/\./g,'').replace(',', '.'));// 1.234,56
    return parseFloat(raw.replace(',', '.'));
  };

  const pickCurrency = (s='') => {
    const low = s.toLowerCase();
    for (const [iso, arr] of Object.entries(currencyMap)) {
      if (arr.some(x => low.includes(x.toLowerCase()))) return iso;
    }
    return '';
  };

  // 6) приоритетный захват: рядом с ключевыми словами
  //    пример: "Сәтті аударылды 594,30 ₸", "Transfer completed successfully 1300 ₸"
  const nearKw = new RegExp(`${kw}\\D{0,40}([\\d\\s.,]+)\\s*(?:(${curRegex}))?`, 'i');
  let amount = null, currency = '';
  {
    const m = nearKw.exec(text);
    if (m) {
      const num = toNumber(m[1]);
      if (isFinite(num) && num > 0) {
        amount = num;
        currency = pickCurrency(m[2] || '') || currency;
      }
    }
  }

  // 7) bank-specific: если «Halyk» или «Kaspi» встречается, усиливаем верхний блок (первые 30% текста)
  if (amount === null) {
    const topPortion = Math.ceil(text.length * 0.3);
    const head = text.slice(0, Math.max(200, topPortion)); // возьмём шапку побольше
    const successHeadRx = new RegExp(
      // success header words
      `(?:Halyk|Kaspi|transfer\\s*(?:completed|success(?:fully)?)|сәтті\\s*аударылды|успешно|успешн|success)`,
      'i'
    );
    if (successHeadRx.test(head)) {
      // соберём все суммы в шапке, игнорируя комиссии
      const lines = head.split(/\r?\n/);
      const candidates = [];
      for (const line of lines) {
        if (!line || feeRx.test(line)) continue; // пропускаем комиссию
        for (const m of line.matchAll(/(\d{1,3}(?:[\s.,]\d{3})*|\d+)(?:[.,]\d{2})?\s*(?:${curRegex})?/gi)) {
          const v = toNumber(m[0]);
          if (!isFinite(v) || v <= 0) continue;
          if (v < 1 || v > 1e8) continue;
          candidates.push({ v, cur: pickCurrency(m[0]) });
        }
      }
      if (candidates.length) {
        // выбираем максимальную сумму в верхнем блоке
        candidates.sort((a,b) => b.v - a.v);
        amount = candidates[0].v;
        currency = candidates[0].cur || currency;
      }
    }
  }

  // 8) общий фоллбек по всем строкам (игнорируя комиссии)
  if (amount === null) {
    const lines = text.split(/[\n\r]+/);
    const candidates = [];
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line || feeRx.test(line)) continue;                // ← пропускаем комиссию
      const hasKW = new RegExp(kw, 'i').test(line);
      const curHit = pickCurrency(line);
      for (const m of line.matchAll(/(\d{1,3}(?:[\s.,]\d{3})*|\d+)(?:[.,]\d{2})?/g)) {
        const v = toNumber(m[0]);
        if (!isFinite(v) || v <= 0) continue;
        if (v < 1 || v > 1e8) continue;
        // «чуть больше» вес крупным суммам и наличию ключевых слов
        const score = (hasKW ? 3 : 0) + (curHit ? 2 : 0) + Math.log10(Math.max(1, v));
        candidates.push({ v, cur: curHit, score });
      }
    }
    if (candidates.length) {
      candidates.sort((a,b) => b.score - a.score);
      amount = candidates[0].v;
      currency = candidates[0].cur || currency;
    }
  }

  if (!amount) return null;
  if (!currency) currency = 'KZT';
  return { amount, currency };
}

async function tryLLMAmount(openaiKey, text) {
  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    const sys = [
      'Ты извлекаешь сумму оплаты из текста чека/квитанции.',
      'Верни ТОЛЬКО JSON без пояснений вида:',
      '{"amount": 1234.56, "currency": "KZT|RUB|USD|EUR|"}',
      'Если валюты нет в тексте — пусти "".',
      'Не путай сумму с номерами карт/телефона/операции.'
    ].join(' ');
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: text.slice(0, 8000) }
      ]
    });
    const raw = (r.choices?.[0]?.message?.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const js = JSON.parse(m[0]);
    const amount = Number(js.amount);
    let currency = String(js.currency || '').toUpperCase();
    if (!isFinite(amount) || amount <= 0) return null;
    if (!['KZT','RUB','USD','EUR'].includes(currency)) currency = '';
    return { amount, currency };
  } catch (_) {
    return null;
  }
}

// Отправить подтверждение в WA и записать чек
async function confirmReceipt(accId, jid, relFile, rawText, parsed){
const tenantId = await getAccTenant(accId);
const accKind = await getAccKind(accId);

const amount = Number(parsed?.amount);
const safeAmount = isFinite(amount) ? amount : 0;
const cur = String(parsed?.currency || '').trim();
const curStr = cur ? ` ${cur}` : '';
const reply = `✅ Түбіртек қабылданды, рақмет! Сома: ${safeAmount.toFixed(2)}${curStr}`;

if (accKind === 'tg') {
  const chatId = tgJidToChatId(jid);
  const recTg = tgBots.get(accId);
  const tgToken = recTg?.token || (await get(`SELECT tg_token FROM accounts WHERE id=?`, [accId]))?.tg_token || '';
  if (tgToken && chatId) {
    await tgSendLongText(tgToken, chatId, reply);
  }
} else {
  const rec = sockets.get(accId); if(!rec?.sock) return;
  const sock = rec.sock;
  await sock.sendMessage(jid, { text: reply });
}

  // Лог в чаты
  const ts=nowSec(), date=new Date(ts*1000).toISOString().slice(0,10);
  const extId = crypto.randomUUID();

  await run(
    `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, jid, date, ts, reply, 'out', accId, relFile||'', relFile?.endsWith('.pdf')?'pdf':'', extId ]
  );

  await pushMessageToCRM({
    tenant_id: tenantId,
    acc_id: accId,
    jid,
    direction: 'out',
    text: reply,
    media_file: relFile || '',
    media_kind: relFile?.endsWith('.pdf') ? 'pdf' : (inferKindFromPath(relFile) || ''),
    external_id: extId
  });

  // Сохранить в receipts
  await run(`INSERT INTO receipts(tenant_id,acc_id,jid,ts,amount,currency,file,raw_text)
             VALUES(?,?,?,?,?,?,?,?)`,
             [tenantId,accId,jid,ts,parsed.amount,parsed.currency||'',relFile||'', String(rawText||'').slice(0,10000)]);

  await notifyTelegram(tenantId, 'payment_received', {
    accId,
    jid,
    receipt: {
      amount: parsed.amount,
      currency: parsed.currency || '',
      file: relFile || '',                // например: 'uploads/123.pdf'
      raw_text_preview: String(rawText||'').slice(0,600)
    }
  });
}

// Отправка длинных текстов безопасно порциями
async function sendLongText(sock, jid, text, _tenantId, _accId){
  const WA_MAX_CHARS = 3500;
  const tenantId = _tenantId ?? '';
  const accId = _accId ?? '';
  const full = String(text || '');
  if (!full.trim()) return '';

  // Нормализуем JID: убираем мусор вида "123:45@s.whatsapp.net"
  // и НЕ превращаем @lid в "номер@s.whatsapp.net" (иначе "придуманные номера")
  const toJid = normalizeDirectJid(jid);
  if (!toJid) {
    console.warn('[WA][SEND][BAD_JID] tid=%s acc=%s jid=%s', tenantId, accId, jid);
    return '';
  }

  const sendOne = async (t) => {
    const r = await sock.sendMessage(toJid, { text: t });
    const id = r?.key?.id || '';
    console.log('[WA][SEND][TEXT] tid=%s acc=%s jid=%s -> %s id=%s len=%s',
      tenantId, accId, jid, toJid, id, (t||'').length
    );
    return id;
  };

  if (full.length <= WA_MAX_CHARS) return await sendOne(full);

  let i=0, lastId='';
  while(i<full.length){
    let end = Math.min(i+WA_MAX_CHARS, full.length);
    const part = full.slice(i,end).trim();
    if(part) lastId = await sendOne(part);
    i=end;
    await sleep(150);
  }
  return lastId;
}

// async function sendVoiceMessage({ sock, tenantId, accId, jid, text, mediaLocalPath }) {
async function sendVoiceMessage({ sock, tenantId, accId, jid, text, mediaLocalPath, previewLocalPath }) {
  // mediaLocalPath: локальный путь к OGG (voice)
  const buf = await fsp.readFile(mediaLocalPath);

  const toJid = normalizeDirectJid(jid);
  if (!toJid) throw new Error('bad jid in sendVoiceMessage: ' + jid);

  // голосовое (ptt: true) — максимально «нативно» выглядит в WhatsApp
  await sock.sendMessage(toJid, { audio: buf, ptt: true, mimetype: 'audio/ogg; codecs=opus' });

  // лог + CRM
  const ts = nowSec(), date = new Date(ts*1000).toISOString().slice(0,10);
  const extId = crypto.randomUUID();
  const relOgg = 'uploads/' + path.basename(mediaLocalPath);

  const relLog = previewLocalPath
    ? 'uploads/' + path.basename(previewLocalPath)   // логируем m4a-превью, если есть
    : relOgg;

  await run(`INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [tenantId, jid, date, ts, text ? text.slice(0, 1000) : '🎙 Голосовое', 'out', accId, relOgg, 'audio', extId]);

  await pushMessageToCRM({
    tenant_id: tenantId,
    acc_id: accId,
    jid,
    direction: 'out',
    text: text || '',
    media_file: relLog,
    media_kind: 'audio',
    external_id: extId
  });
}

async function sendVoiceMessageTG({ token, tenantId, accId, jid, text, mediaLocalPath, previewLocalPath }) {
  const chatId = tgJidToChatId(jid);
  if (!chatId) throw new Error('bad TG jid: ' + jid);
  if (!token) throw new Error('no tg token in sendVoiceMessageTG');

  const relOgg = 'uploads/' + path.basename(mediaLocalPath);

  // tgSendMediaFromUploads сам отправит как voice если .ogg
  await tgSendMediaFromUploads(token, chatId, 'audio', relOgg, '');

  const ts = nowSec(), date = new Date(ts * 1000).toISOString().slice(0, 10);
  const extId = crypto.randomUUID();

  const relLog = previewLocalPath
    ? 'uploads/' + path.basename(previewLocalPath)
    : relOgg;

  await run(
    `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, jid, date, ts, text ? text.slice(0, 1000) : '🎙 Голосовое', 'out', accId, relOgg, 'audio', extId]
  );

  await pushMessageToCRM({
    tenant_id: tenantId,
    acc_id: accId,
    jid,
    direction: 'out',
    text: text || '',
    media_file: relLog,
    media_kind: 'audio',
    external_id: extId
  });
}

async function sendVoiceMessageWABA({ tenantId, accId, jid, text, mediaLocalPath, previewLocalPath }) {
  // mediaLocalPath: путь к ogg (voice)
  const abs = path.isAbsolute(mediaLocalPath) ? mediaLocalPath : path.join(__dirname, mediaLocalPath);

  // отправляем как audio через Meta Cloud API
  await sendViaWABA(accId, jid, '', abs, 'audio');

  // лог + CRM
  const ts = nowSec(), date = new Date(ts*1000).toISOString().slice(0,10);
  const extId = crypto.randomUUID();
  const relOgg = 'uploads/' + path.basename(abs);

  const relLog = previewLocalPath
    ? ('uploads/' + path.basename(previewLocalPath))
    : relOgg;

  await run(`INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [tenantId, jid, date, ts, text ? text.slice(0, 1000) : '🎙 Голосовое', 'out', accId, relOgg, 'audio', extId]);

  await pushMessageToCRM({
    tenant_id: tenantId,
    acc_id: accId,
    jid,
    direction: 'out',
    text: text || '',
    media_file: relLog,
    media_kind: 'audio',
    external_id: extId
  });
}

function htmlEsc(s=''){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

async function tgShouldSend(tenantId, event, jid, cooldownSec = 7200){
  const row = await get(
    `SELECT ts FROM tg_sent WHERE tenant_id=? AND event=? AND jid=?`,
    [tenantId, event, jid]
  );
  const now = nowSec();
  if (row && (now - Number(row.ts||0) < cooldownSec)) return false;
  await run(
    `INSERT OR REPLACE INTO tg_sent(tenant_id,event,jid,ts) VALUES(?,?,?,?)`,
    [tenantId, event, jid, now]
  );
  return true;
}

async function inferShortIntent(tenantId, accId, jid){
  const key = await getOpenAIKeyForTenant(tenantId);
  if (!key) return '';
  try{
    // берём последние сообщения диалога
    const lastMsgs = await all(
      `SELECT type,message FROM chats
       WHERE tenant_id=? AND acc_id=? AND jid=?
       ORDER BY ts DESC,id DESC LIMIT 8`,
      [tenantId, accId, jid]
    );
    lastMsgs.reverse();
    const txt = lastMsgs.map(r => (r.type==='in'?'Клиент: ':'Бот: ') + (r.message||'')).join('\n');

    const openai = new OpenAI({ apiKey: key });
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 40,
      messages:[
        {role:'system', content:'Сформулируй кратко (4–8 слов) чего хочет клиент. Без точки, без кавычек.'},
        {role:'user', content: txt || '(пусто)'}
      ]
    });
    return (r.choices?.[0]?.message?.content||'').trim().slice(0,80);
  }catch(_){ return ''; }
}

function toWaJid(input){
  const s = String(input || '').trim();
  if (!s) return '';

  // если есть буквы — это точно не номер (защита от "счет 2025", "акт 123" и т.п.)
  if (/[A-Za-zА-Яа-я]/.test(s)) return '';

  let digits = s.replace(/\D+/g, '');
  if (!digits) return '';

  // частый кейс KZ/RU: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);

  // защита от дат в формате YYYYMMDD (8 цифр)
  if (digits.length === 8) {
    const y = parseInt(digits.slice(0,4), 10);
    const m = parseInt(digits.slice(4,6), 10);
    const d = parseInt(digits.slice(6,8), 10);
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return '';
  }

  // E.164: от 8 до 15 цифр (включая код страны)
  if (digits.length < 8 || digits.length > 15) return '';

  return digits + '@s.whatsapp.net';
}

function normalizeDirectJid(jid){
  const raw0 = String(jid || '').trim();
  if (!raw0) return '';

  // если вдруг где-то прилетает с префиксом "accId:"
  const raw = raw0.replace(/^(\d+):/, '');

  // ВАЖНО: если уже есть домен — возвращаем КАК ЕСТЬ (включая @lid)
  // (но для @s.whatsapp.net дополнительно чистим мусор)
  if (raw.endsWith('@s.whatsapp.net')) {
    const digits = raw.replace(/@s\.whatsapp\.net$/,'').replace(/\D+/g,'');
    if (digits.length >= 8 && digits.length <= 15) return digits + '@s.whatsapp.net';
    return raw;
  }

  if (
    raw === 'status@broadcast' ||
    raw.endsWith('@lid') ||
    raw.endsWith('@g.us') ||
    raw.endsWith('@broadcast') ||
    raw.endsWith('@newsletter')
  ) return raw;

  // если пришли просто цифры без домена
  if (/^\d{8,15}$/.test(raw)) return raw + '@s.whatsapp.net';

  return raw;
}

function normalizeMeJid(me){
  const raw0 = String(me || '').trim();
  if (!raw0) return '';

  // приводим к "digits@domain" и убираем ":device" (например ":52")
  if (raw0.includes('@')) {
    const at = raw0.indexOf('@');
    const left = raw0.slice(0, at);      // "7747...:52"
    const dom  = raw0.slice(at + 1);     // "s.whatsapp.net"
    const left2 = left.split(':')[0];    // "7747..."
    const digits = left2.replace(/\D+/g, '');
    if (digits) return `${digits}@${dom}`;
    return raw0;
  }

  // если вдруг пришло просто число без домена
  return normalizeDirectJid(raw0);
}

// Возвращаем ТОЛЬКО реальный телефон (если он есть).
// Для tg:/@lid/@g.us/@broadcast/... будет пусто.
// Поддерживает:
//  - "7705...@s.whatsapp.net" -> "7705..."
//  - "7705..." или "+7705 ..." -> "7705..."
//  - "accId:7705...@s.whatsapp.net" -> "7705..."
function jidToPhone(jid){
  const s0 = String(jid || '').trim();
  if (!s0) return '';

  // если вдруг где-то прилетает с префиксом "accId:"
  const s = s0.replace(/^(\d+):/, '');

  if (s.startsWith('tg:')) return '';

  if (
    s === 'status@broadcast' ||
    s.endsWith('@lid') ||
    s.endsWith('@g.us') ||
    s.endsWith('@broadcast') ||
    s.endsWith('@newsletter')
  ) return '';

  let digits = '';

  if (s.endsWith('@s.whatsapp.net')) {
    digits = s.replace(/@s\.whatsapp\.net$/, '').replace(/\D+/g, '');
  } else {
    // старые данные могли быть просто цифрами или "+..."
    digits = s.replace(/\D+/g, '');
  }

  if (!digits) return '';

  // частый кейс KZ/RU: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);

  // E.164: от 8 до 15 цифр
  if (digits.length < 8 || digits.length > 15) return '';

  return digits;
}


// --- Phone helpers (LID-safe) ---
// true if digits look like a real E.164-ish phone number (8..15 digits)
function looksLikePhoneDigits(d){
  const s = String(d || '').replace(/\D+/g, '');
  if (!s) return false;
  if (s.length < 8 || s.length > 15) return false;
  // don't over-restrict by country here; verification below is stronger
  return true;
}

// verify by asking WhatsApp (safe: avoids treating phone_number_id etc. as "phone")
async function isPhoneOnWhatsApp(sock, digits){
  try{
    const d = String(digits || '').replace(/\D+/g, '');
    if (!looksLikePhoneDigits(d)) return false;
    if (!sock || typeof sock.onWhatsApp !== 'function') return false;

    const r = await sock.onWhatsApp(d);
    if (Array.isArray(r) && r[0] && (r[0].exists === true || r[0].exists === 1)) return true;
    if (r && r.exists === true) return true;
  }catch(_){}
  return false;
}

// resolve phone for any direct jid, including @lid via lid_mapping
async function resolvePhoneForAccJid(accId, jid){
  const direct = jidToPhone(jid);
  if (direct) return direct;

  try{
    const j = normalizeDirectJid(jid);
    if (!j || !j.endsWith('@lid')) return '';

    const row = await get(
      `SELECT phone_number FROM lid_mapping
       WHERE acc_id=? AND lid=? AND is_verified=1
       ORDER BY updated_at DESC LIMIT 1`,
      [accId, j]
    );
    return String(row?.phone_number || '').trim();
  }catch(_){}
  return '';
}

// --- Media URL helper for UI ---
// Stores in DB as "uploads/..." (filesystem relative), but UI must load from "/uploads/..."
function toPublicMediaPath(rel){
  const s = String(rel || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return '/' + s.replace(/^\/+/, '');
}


// --- Reactions overlay helpers ---
function safeJsonParse(s, fallback){ try{ return JSON.parse(s); }catch(_){ return fallback; } }
function uniqEmojis(arr){
  const out = [], seen = new Set();
  for (const e of (arr||[])){
    const t = String(e||'').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}
function addEmojiToReactionsJson(reactions_json, emoji){
  const data = safeJsonParse(reactions_json, { e: [] }) || { e: [] };
  data.e = uniqEmojis([...(data.e||[]), emoji]);
  return JSON.stringify({ e: data.e });
}
function toggleEmojiInReactionsJson(reactions_json, emoji){
  const data = safeJsonParse(reactions_json, { e: [] }) || { e: [] };
  const list = uniqEmojis(data.e||[]);
  const has = list.includes(emoji);
  const next = has ? list.filter(x=>x!==emoji) : [...list, emoji];
  return JSON.stringify({ e: next });
}
async function upsertReactionAdd(tenantId, accId, jid, msgRef, emoji){
  const now = nowSec();
  const row = await get(
    `SELECT reactions_json FROM msg_reactions WHERE tenant_id=? AND acc_id=? AND jid=? AND msg_ref=?`,
    [tenantId, accId, jid, msgRef]
  );
  const next = addEmojiToReactionsJson(row?.reactions_json || '', emoji);
  await run(
    `INSERT INTO msg_reactions(tenant_id, acc_id, jid, msg_ref, reactions_json, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, acc_id, jid, msg_ref)
     DO UPDATE SET reactions_json=excluded.reactions_json, updated_at=excluded.updated_at`,
    [tenantId, accId, jid, msgRef, next, now]
  );
  return next;
}
async function upsertReactionToggle(tenantId, accId, jid, msgRef, emoji){
  const now = nowSec();
  const row = await get(
    `SELECT reactions_json FROM msg_reactions WHERE tenant_id=? AND acc_id=? AND jid=? AND msg_ref=?`,
    [tenantId, accId, jid, msgRef]
  );
  const next = toggleEmojiInReactionsJson(row?.reactions_json || '', emoji);
  await run(
    `INSERT INTO msg_reactions(tenant_id, acc_id, jid, msg_ref, reactions_json, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, acc_id, jid, msg_ref)
     DO UPDATE SET reactions_json=excluded.reactions_json, updated_at=excluded.updated_at`,
    [tenantId, accId, jid, msgRef, next, now]
  );
  return next;
}
async function attachReactionsToRows(tenantId, accId, jid, rows){
  if (!rows || !rows.length) return rows;

  // We support both new refs (wa_id) and legacy refs (chat:<id> / whatever was stored before)
  const refs = [];
  for (const r of rows){
    const wa   = String(r.wa_id || '').trim();
    const chat = (r && (r.id !== undefined && r.id !== null)) ? `chat:${r.id}` : '';
    const legacy = String(r.msg_ref || '').trim();

    if (wa) refs.push(wa);
    if (chat) refs.push(chat);
    if (legacy && legacy !== wa && legacy !== chat) refs.push(legacy);
  }

  const uniq = [...new Set(refs)].filter(Boolean);
  if (!uniq.length){
    for (const r of rows){
      const wa   = String(r.wa_id || '').trim();
      const chat = (r && (r.id !== undefined && r.id !== null)) ? `chat:${r.id}` : '';
      r.msg_ref = wa || chat || '';
      r.reactions_json = '';
    }
    return rows;
  }

  const qMarks = uniq.map(()=>'?').join(',');
  const list = await all(
    `SELECT msg_ref, reactions_json
       FROM msg_reactions
      WHERE tenant_id=? AND acc_id=? AND jid=?
        AND msg_ref IN (${qMarks})`,
    [tenantId, accId, jid, ...uniq]
  );

  const map = new Map();
  for (const x of (list||[])){
    map.set(String(x.msg_ref||''), String(x.reactions_json||''));
  }

  for (const r of rows){
    const wa   = String(r.wa_id || '').trim();
    const chat = (r && (r.id !== undefined && r.id !== null)) ? `chat:${r.id}` : '';
    const legacy = String(r.msg_ref || '').trim();

    const rx = (wa && map.get(wa)) || (chat && map.get(chat)) || (legacy && map.get(legacy)) || '';
    r.msg_ref = wa || chat || legacy || '';
    r.reactions_json = rx;
  }

  return rows;
}

// --- WA: unwrap nested message containers (ephemeral / view-once / edited, etc.)
function unwrapWAMessage(m){
  let msg = m || {};
  for (let i = 0; i < 6; i++) {
    if (msg?.ephemeralMessage?.message) { msg = msg.ephemeralMessage.message; continue; }
    if (msg?.viewOnceMessageV2?.message) { msg = msg.viewOnceMessageV2.message; continue; }
    if (msg?.viewOnceMessageV2Extension?.message) { msg = msg.viewOnceMessageV2Extension.message; continue; }
    if (msg?.viewOnceMessage?.message) { msg = msg.viewOnceMessage.message; continue; }
    if (msg?.documentWithCaptionMessage?.message) { msg = msg.documentWithCaptionMessage.message; continue; }
    if (msg?.editedMessage?.message) { msg = msg.editedMessage.message; continue; }
    break;
  }
  return msg || {};
}

function withinWorkHours(from, to) {
  const parse = (s, fb) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s||'').trim());
    if (!m) return fb;
    const h = +m[1], mi = +m[2];
    if (h<0||h>23||mi<0||mi>59) return fb;
    return h*60 + mi;
  };

  // дефолт, если пришло пусто/криво
  const a = parse(from, 0);             // 00:00
  const b = parse(to,   23*60 + 59);    // 23:59

  const now = new Date();
  const cur = now.getHours()*60 + now.getMinutes();

  // окно может быть «дневное» (a <= b) или «через полночь» (a > b)
  return (a <= b) ? (cur >= a && cur <= b) : (cur >= a || cur <= b);
}

function randInt(min, max){ return Math.floor(min + Math.random()*(max-min+1)); }

async function formatParagraphsLLM(openaiKey, text, langHint=''){
  const src = String(text||'').trim();
  if (!src) return src;

  // если абзацы уже есть — не трогаем
  if (/\n{2,}/.test(src)) return src;

  try{
    const openai = new OpenAI({ apiKey: openaiKey });
    const system = [
      'Ты типограф/редактор форматирования.',
      'Задача: разбить данный текст на абзацы, вставляя пустые строки в естественных местах.',
      'Очень важно: НЕ изменяй слова, их порядок и пунктуацию; НИЧЕГО не добавляй и не удаляй.',
      'Единственное действие — вставка \\n\\n между предложениями там, где это логично.',
      'Сохраняй исходный язык и регистр. Верни только отформатированный текст.'
    ].join(' ');
    const user = (langHint?`[lang=${langHint}] `:'') + src;

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: Math.min(800, src.length*2), // запас на переносы
      messages: [
        { role:'system', content: system },
        { role:'user',   content: user }
      ]
    });
    const out = (r.choices?.[0]?.message?.content||'').trim();
    // на всякий — если модель вдруг «переумничала»
    if (!out || out.length < src.length*0.8) return src;
    return out;
  }catch(_){
    return src;
  }
}

// ——— Удаляем лишние “извините/не могу/как ИИ” из ответов vision/ocr
function sanitizeVisionText(s='') {
  let t = String(s || '');

  // вырезаем целые предложения-отговорки
  const dropPatterns = [
    /(?:извините|простите)[^.!?]*[.!?]/gi,
    /(?:я\s+не\s+могу|не\s+могу|не\s+в\s+состоянии|не\s+удалось|не\s+получилось)[^.?!]*[.?!]/gi,
    /(?:не\s+разборчив|трудно\s+прочитать|низкое\s+качество)[^.?!]*[.?!]/gi,
    /как\s+модель(?:[^.?!])*[.?!]/gi,
    /как\s+ИИ(?:[^.?!])*[.?!]/gi,
    /возможно,\s+ошибаюсь[^.?!]*[.?!]/gi,
    /скорее\s+всего[^.?!]*[.?!]/gi
  ];
  for (const rx of dropPatterns) t = t.replace(rx, ' ');

  // точечные фразы
  const drops = [
    'не могу распознать текст',
    'текст не читается',
    'распознать не удалось',
    'я не уверен',
    'возможно это'
  ];
  for (const d of drops) t = t.replace(new RegExp(d, 'gi'), ' ');

  // убираем двойные пробелы/пустые строки
  t = t.replace(/\s{2,}/g, ' ').replace(/(\n\s*){3,}/g, '\n\n').trim();

  // если после чистки совсем пусто — вернём пустую строку (а не отговорку)
  return t;
}

async function pushLeadToCRM({ tenant_id, acc_id, jid, phone, last_message, wa_display_name, username = '' }) {
  try {
    const enabled  = (await getSetting('crm_enabled', tenant_id) || '0') === '1';
    if (!enabled) return;

    const endpoint  = (await getSetting('crm_endpoint',  tenant_id) || '').trim();
    const companyId = (await getSetting('crm_company_id', tenant_id) || '').trim();
    const apiKey    = (await getSetting('crm_company_api_key', tenant_id) || '').trim();
    if (!endpoint || !companyId || !apiKey) return;

    const kind = await getAccKind(acc_id);
    const platform = (kind === 'ig') ? 'instagram' : (kind === 'tg') ? 'telegram' : 'whatsapp';

    const prof = await getProfile(acc_id, jid);
    const isRepeat = !!(prof?.crm_id && String(prof.crm_id).trim());

    // имя лида
    const leadName = (wa_display_name && wa_display_name.trim())
      ? wa_display_name.trim()
      : (platform === 'instagram') ? 'Instagram User'
        : (platform === 'telegram') ? 'Telegram User'
        : 'WhatsApp User';

    const usernameSafe = String(username || '').trim().replace(/^@/, '');

    // телефон лида — только цифры (обязателен только для WA)
    let digits = String(phone || '').replace(/[^\d]/g, '');
    if (platform === 'whatsapp') {
      // если jid = @lid и номер скрыт — пробуем взять из lid_mapping (если уже верифицирован)
      if (!digits || digits.length < 8 || digits.length > 15) {
        try {
          const resolved = await resolvePhoneForAccJid(acc_id, jid);
          const d2 = String(resolved || '').replace(/[^\d]/g, '');
          if (d2 && d2.length >= 8 && d2.length <= 15) digits = d2;
        } catch(_) {}
      }
      if (!digits || digits.length < 8 || digits.length > 15) {
        console.warn('[CRM] skip push: bad phone:', phone);
        return;
      }
    }

    // наш WA-аккаунт: номер и лейбл — чтобы отобразить "NeDzat: +7... (Label)"
    const acc = await get(`SELECT label, me_jid FROM accounts WHERE id=?`, [acc_id]);
    const accLabel = (acc?.label || '').trim();
    const accJid   = (acc?.me_jid || '').trim();                  // "7705xxxxxxx@s.whatsapp.net"
    const accPhone = accJid ? ('+' + accJid.replace(/@.*/, '')) : '';
    const crmSource = `${accPhone}${accLabel ? ` (${accLabel})` : ''}`.trim();

    const messageSafe = String(last_message || (platform === 'instagram' ? 'Новый лид из Instagram' : platform === 'telegram' ? 'Новый лид из Telegram' : 'Новый лид из WhatsApp'));

    // --- Попытка A: всё в теле (как раньше просили): name/phone/company_id/api_key + source (+ message опционально)
    const bodyA = {
      company_id: companyId,
      api_key: apiKey,
      tenant_id: String(tenant_id),
      account_id: String(acc_id),
      platform,

      phone: platform === 'whatsapp' ? digits : '',
      name: leadName,
      username: usernameSafe,
      source: crmSource,
      message: messageSafe,

      jid: String(jid || ''),
      is_repeat: isRepeat ? 1 : 0,

      direction: 'in',
      event_type: 'lead',
      timestamp: new Date().toISOString(),
      external_id: `lead:${tenant_id}:${acc_id}:${jid}`
    };

    try {
      const resA = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyA)
        },
        15000
      );
      const textA = await resA.text().catch(() => '');
      console.warn('[CRM] A strict-four+source →', resA.status, textA);
      if (resA.ok && resA.status < 300) {
        // внутри успешной ветки resA.ok/resB.ok
        try {
          const js = JSON.parse(textA || '{}');
          if (js && (js.id || js.lead_id)) {
            await saveProfile(acc_id, jid, { crm_id: String(js.id || js.lead_id), crm_url: String(js.url || '') });
          }
        } catch(_) {}

        await setSetting('crm_payload_mode', 'strict-four+source', tenant_id);
        return;
      }
    } catch (e) {
      console.warn('[CRM] A strict-four+source exception:', e?.message || e);
    }

    // --- Попытка B: ключи в заголовках, а в теле name/phone + source (+ message)
    const bodyB = {
      name: leadName,
      username: usernameSafe,
      phone: platform === 'whatsapp' ? digits : '',
      source: crmSource,
      message: messageSafe,
      tenant_id: String(tenant_id),
      account_id: String(acc_id),
      platform,
      jid: String(jid || ''),
      is_repeat: isRepeat ? 1 : 0
    };

    try {
      const resB = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Company-Id': companyId,
            'apikey': apiKey,
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(bodyB)
        },
        15000
      );
      const textB = await resB.text().catch(() => '');
      console.warn('[CRM] B headers-minimal+source →', resB.status, textB);
      if (resB.ok && resB.status < 300) {
        // внутри успешной ветки resA.ok/resB.ok
        try {
          const js = JSON.parse(textB || '{}');
          if (js && (js.id || js.lead_id)) {
            await saveProfile(acc_id, jid, { crm_id: String(js.id || js.lead_id), crm_url: String(js.url || '') });
          }
        } catch(_) {}

        await setSetting('crm_payload_mode', 'headers-minimal+source', tenant_id);
        return;
      }
    } catch (e) {
      console.warn('[CRM] B headers-minimal+source exception:', e?.message || e);
    }

    console.warn('[CRM] push failed: both variants returned 4xx/5xx');
  } catch (e) {
    console.warn('[CRM] push error', e?.message || e);
  }
}

// === REPLACE pushMessageToCRM ===
async function pushMessageToCRM({
  tenant_id, acc_id, jid, direction, text,
  media_file = '', media_kind = '',
  external_id = '',
  username = ''
}) {
  try {
    const endpoint   = (await getSetting('crm_msg_endpoint', tenant_id) || '').trim();
    const enabled    = (await getSetting('crm_enabled', tenant_id) || '') === '1';
    const companyId  = (await getSetting('crm_company_id', tenant_id) || '').trim();
    const apiKey     = (await getSetting('crm_company_api_key', tenant_id) || '').trim();
    if (!enabled || !endpoint || !companyId || !apiKey) return;

    const prof = await getProfile(acc_id, jid);
    const acc  = await get(`SELECT label, me_jid FROM accounts WHERE id=?`, [acc_id]);

    const accKind = await getAccKind(acc_id);
    const platform =
      (accKind === 'ig') ? 'instagram'
      : (accKind === 'tg') ? 'telegram'
      : 'whatsapp';

    const displayName = (prof?.name && String(prof.name).trim())
      ? String(prof.name).trim()
      : (platform === 'instagram') ? 'Instagram User'
      : (platform === 'telegram') ? 'Telegram User'
      : 'WhatsApp User';

    const accLabel = (acc?.label || '').trim();
    const accJid   = (acc?.me_jid || '').trim();

    const accPhone = accJid ? ('+' + accJid.replace(/@.*/, '')) : '';
    const source   = [accPhone, accLabel && `@${accLabel}`].filter(Boolean).join(' ');

    // phone (для WA чаще всего это jid без домена)
    let phoneDigits = '';
    try { phoneDigits = jidToPhone(jid) || ''; } catch (_) {}
    const phoneE164 = phoneDigits ? ('+' + phoneDigits) : '';

    // ✅ FIX: usernameNorm (чтобы не падало вообще никогда)
    const usernameNorm = (username ?? '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '_')
      .slice(0, 64) || phoneDigits || jidToPhone(jid);

    // ⚠️ раньше у тебя было: if (platform==='whatsapp' && !phoneDigits) return;
    // из-за этого WA c @lid / скрытым номером вообще не уходил в CRM/AI.
    // УБИРАЕМ этот return: пусть уходит хотя бы с jid.

    const payload = {
      company_id: companyId,
      api_key: apiKey,

      tenant_id,
      acc_id,

      platform,
      direction,              // in/out
      jid: String(jid || ''),
      username: String(username || ''),
      username_norm: usernameNorm,

      phone: phoneE164,       // может быть пусто
      name: displayName,
      text: String(text || ''),

      ts: nowSec(),
      source,

      media_kind: String(media_kind || ''),
      media_file: String(media_file || ''),

      external_id: String(external_id || ''),
    };

    let resp;
    try {
      resp = await axios.post(endpoint, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      // fallback на случай 4xx/5xx
      console.warn('[CRM] push error', e?.response?.status, e?.message || e);
      throw e;
    }

    try {
      const js = resp?.data || {};
      if (js && (js.lead_id || js.id)) {
        await saveProfile(acc_id, jid, { crm_id: String(js.lead_id || js.id), crm_url: String(js.url || '') });
      }
    } catch (_) {}

  } catch (e) {
    console.warn('[CRM][MSG] error', e?.message || e);
  }
}

async function completeUntilDone(openai, baseMessages, {
  model = 'gpt-4o',
  temperature = 0.7,
  chunkTokens = 800,      // сколько просим за раз
  maxParts = 4,           // максимум «допродолжений»
  // totalMaxTokens оставили в сигнатуре только для совместимости, внутри не используем
  totalMaxTokens = null
} = {}) {
  let messages = baseMessages.slice();
  let full = '';
  let parts = 0;

  // накапливаем usage по всем кускам
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  while (parts < maxParts) {
    const resp = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: chunkTokens,
      messages
    });

    const u = resp.usage || {};
    if (u.total_tokens)       totalTokens      += u.total_tokens;
    if (u.completion_tokens)  completionTokens += u.completion_tokens;
    if (u.prompt_tokens)      promptTokens += Number(u?.prompt_tokens||0);

    const choice = resp.choices?.[0];
    const piece  = (choice?.message?.content || '').trim();
    const reason = choice?.finish_reason || '';

    if (piece) {
      full += piece;
    }

    if (reason && reason !== 'length') break;

    parts += 1;
    if (parts >= maxParts) break;

    messages = [
      ...messages,
      { role: 'assistant', content: piece || '' },
      { role: 'user', content: 'Продолжай с того места, где остановился. Не повторяйся и не пиши преамбул.' }
    ];
  }

  return {
    text: full.trim(),
    usage: {
      total_tokens:      totalTokens      || null,
      prompt_tokens:     promptTokens     || null,
      completion_tokens: completionTokens || null
    }
  };
}

const OPENAI_PRICE_PER_1M = {
  'gpt-4o':      { in: 2.50, out: 10.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
};

function normalizeModelName(m){
  return String(m || '').trim().toLowerCase();
}

function calcOpenAICostUSD(model, promptTokens, completionTokens){
  const key = normalizeModelName(model);
  const p = OPENAI_PRICE_PER_1M[key];
  if(!p) return 0;

  const pt = Number(promptTokens || 0);
  const ct = Number(completionTokens || 0);

  const cost = (pt / 1_000_000) * p.in + (ct / 1_000_000) * p.out;
  return Math.round(cost * 1e6) / 1e6; // аккуратно до микродоллара
}

// Перед отправкой текста проверяем, не слали ли мы такой же недавно
async function hasRecentlySent(tenantId, accId, jid, text, windowSec = 60) {
  if (!text || !text.trim()) return false;
  const since = nowSec() - Math.max(5, windowSec);
  const row = await get(
    `SELECT id FROM chats
     WHERE tenant_id=? AND acc_id=? AND jid=? AND type='out' AND message=? AND ts >= ?
     ORDER BY id DESC LIMIT 1`,
    [tenantId, accId, jid, String(text).trim(), since]
  );
  return !!row;
}

async function ensureCrmApiKey(tenantId) {
  let key = (await getSetting('crm_api_key', tenantId) || '').trim();
  if (!key) {
    key = crypto.randomUUID(); // UUID v4
    await setSetting('crm_api_key', key, tenantId);
  }
  return key;
}

async function isAIEnabledForAccount(accId){
  const r = await get(`SELECT ai_enabled FROM accounts WHERE id=?`, [accId]);
  return Number(r?.ai_enabled ?? 1) === 1;
}

// -------------------------------------------------
// XLSX helpers (auto width, buffer writer)
// -------------------------------------------------
function aoaToSheetWithAutowidth(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const colWidths = [];
  for (const row of aoa) {
    row.forEach((cell, i) => {
      const v = (cell == null ? '' : String(cell));
      colWidths[i] = Math.max(colWidths[i] || 10, Math.min(60, v.length + 2));
    });
  }
  ws['!cols'] = (colWidths || []).map(w => ({ wch: w }));
  return ws;
}

function sendWorkbook(res, wb, filename = 'export.xlsx') {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

async function synthesizeTTS(openaiKey, text, {
  model='gpt-4o-mini-tts',
  voice='alloy',
  rate='1.0',
  pitch='0',
  lang=''
} = {}) {
  const openai = new OpenAI({ apiKey: openaiKey });
  // делаем простой, максимально совместимый mp3
  const outBase = path.join(UPLOAD_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mp3Path = `${outBase}.mp3`;

  // небольшая «подсказка» модели про язык/стиль
  const prefix = lang ? `[lang=${lang}; rate=${rate}; pitch=${pitch}] ` : '';
  const input = (prefix + String(text||'')).slice(0, 4000);

  const resp = await openai.audio.speech.create({
    model,
    voice,
    input
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  await fsp.writeFile(mp3Path, buf);

  // Превратим в OGG/Opus 16k моно для WA-voice (и сделаем m4a-превью для CRM/браузера)
  const { abs: oggPath, mime, ptt } = await normalizeAudioForWA(mp3Path);
  const m4aPreview = await safeMakePreviewM4A(oggPath);

  return { oggPath, mime, ptt, previewPath: m4aPreview };
}

// ==== Booking intent via LLM (ru/kk/en) ====
async function detectBookingIntentLLM(openaiKey, convoTail) {
  const openai = new OpenAI({ apiKey: openaiKey });
  const sys = [
    'Ты классификатор намерений в мессенджере.',
    'Ответь ТОЛЬКО JSON без комментариев.',
    `{"wants_booking": true|false, "confidence": 0..1}`
  ].join(' ');
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini', temperature: 0, max_tokens: 30,
    messages: [
      { role:'system', content: sys },
      { role:'user', content: convoTail.slice(-1500) || '(пусто)' }
    ]
  });
  try {
    const js = JSON.parse((r.choices?.[0]?.message?.content||'').match(/\{[\s\S]*\}/)?.[0]||'{}');
    return !!js.wants_booking;
  } catch { return false; }
}

// ==== Extract requested local datetime window (если клиент сам назвал время) ====
async function extractRequestedTimeWindow(openaiKey, text, defaultTz='Asia/Almaty') {
  const nowISO = new Date().toISOString();
  const openai = new OpenAI({ apiKey: openaiKey });
  const sys = [
    'Ты парсер дат/времени (ru/kk/en).',
    'Всегда интерпретируй относительные фразы ("сегодня", "завтра", "через час", просто "16:00") относительно NOW и TIMEZONE.',
    'Выбирай БЛИЖАЙШЕЕ БУДУЩЕЕ время. Если указано только время — это сегодня, если уже прошло — завтра.',
    'Верни ТОЛЬКО JSON:',
    '{"has_time":true|false,"start_iso":"","end_iso":"","timezone":""}',
    'Если конца нет — end_iso="". timezone заполни, если указали, иначе оставь пусто.'
  ].join(' ');
  const user = [
    `NOW=${nowISO}`,
    `TIMEZONE=${defaultTz}`,
    '',
    String(text||'').slice(0, 1200)
  ].join('\n');

  const r = await openai.chat.completions.create({
    model:'gpt-4o-mini', temperature:0, max_tokens:120,
    messages:[ {role:'system', content: sys}, {role:'user', content: user} ]
  });

  try {
    const js = JSON.parse((r.choices?.[0]?.message?.content||'').match(/\{[\s\S]*\}/)?.[0]||'{}');
    if (!js.has_time) return null;
    return {
      start: js.start_iso || '',
      end: js.end_iso || '',
      timezone: js.timezone || defaultTz
    };
  } catch { return null; }
}

// --- TIME NORMALIZATION HELPERS: гарантируем ближайшее будущее в TZ ---
function _partsInTZ(d, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x=>[x.type,x.value]));
  return { y:+p.year, M:+p.month, d:+p.day, h:+p.hour, m:+p.minute, s:+p.second };
}
function _toDateFromPartsInTZ(y, M, d, h, m, s, tz) {
  // хотим: Instant, соответствующий стеночному времени y-M-d h:m:s в поясе tz
  // 1) берём "как будто это UTC"
  const desiredWallUTC = Date.UTC(y, M - 1, d, h, m, s);
  const probe = new Date(desiredWallUTC); // пока просто точка во времени

  // 2) узнаём, какой "стеночный" сейчас у этой точки в нужном поясе
  const p = _partsInTZ(probe, tz);
  const currentWallUTC = Date.UTC(p.y, p.M - 1, p.d, p.h, p.m, p.s);

  // 3) дельта между "какой хотим стеночный" и "какой получился" -> сдвигаем
  const deltaMs = desiredWallUTC - currentWallUTC;

  return new Date(probe.getTime() + deltaMs);
}
function _addMinutes(date, min){ return new Date(date.getTime() + min*60000); }

/**
 * Приводит окно к "ближайшему будущему" в заданном поясе:
 * - если год/дата прошлого — подтягиваем к текущему году/завтра и т.п.
 * - если нет end — добавляем дефолтную длительность
 */
function normalizeFutureWindow({ startISO, endISO='', tz='Asia/Almaty', defDurMin=30 }) {
  if (!startISO) return null;
  let start = new Date(startISO);
  let end   = endISO ? new Date(endISO) : null;

  const now = new Date();
  const nowP   = _partsInTZ(now, tz);
  let   sP     = _partsInTZ(start, tz);

  // если год «старый» — подтянуть год к текущему
  if (sP.y < nowP.y) {
    start = _toDateFromPartsInTZ(nowP.y, sP.M, sP.d, sP.h, sP.m, sP.s, tz);
    sP = _partsInTZ(start, tz);
  }

  // сравнение "в TZ"
  const nowCmp   = _toDateFromPartsInTZ(nowP.y, nowP.M, nowP.d, nowP.h, nowP.m, nowP.s, tz);
  let   startCmp = _toDateFromPartsInTZ(sP.y, sP.M, sP.d, sP.h, sP.m, sP.s, tz);

  // если получилось "в прошлом" (напр. сегодня 17:10, а попросили 16:00) — переносим на завтра
  if (startCmp.getTime() <= nowCmp.getTime()) {
    const tomorrow = new Date(nowCmp.getTime() + 24*3600*1000);
    const tP = _partsInTZ(tomorrow, tz);
    start = _toDateFromPartsInTZ(tP.y, tP.M, tP.d, sP.h, sP.m, sP.s, tz);
    startCmp = start;
  }

  // если end не задан или <= start — добавим дефолтную длительность
  if (!end || end.getTime() <= start.getTime()) {
    end = _addMinutes(start, Math.max(15, defDurMin|0 || 30));
  }

  return { start, end };
}

function pickLocale(lang='') {
  const m = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US' };
  return m[lang] || 'ru-RU';
}

function fmtRangeLocal(startISO, endISO, tz, lang='ru') {
  const loc = pickLocale(lang);
  const fmtDate = new Intl.DateTimeFormat(loc, {
    timeZone: tz,
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  const fmtTime = new Intl.DateTimeFormat(loc, {
    timeZone: tz, hour: '2-digit', minute: '2-digit'
  });

  const s = new Date(startISO), e = new Date(endISO);
  const sameDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day:'2-digit', month:'2-digit', year:'numeric' })
                    .format(s) ===
                  new Intl.DateTimeFormat('en-GB', { timeZone: tz, day:'2-digit', month:'2-digit', year:'numeric' })
                    .format(e);

  if (sameDay) {
    return `${fmtDate.format(s)}, ${fmtTime.format(s)}–${fmtTime.format(e)} (${tz})`;
  }
  return `${fmtDate.format(s)} ${fmtTime.format(s)} – ${fmtDate.format(e)} ${fmtTime.format(e)} (${tz})`;
}

async function smartBookingReply({ openaiKey, lang='ru', name='', startISO, endISO, tz }) {
  // красивый человекочитаемый слот
  const when = fmtRangeLocal(startISO, endISO, tz, lang);

  // fallback на случай, если LLM не доступен
  const FALLBACK = {
    kk: (name?`${name}, `:'') + `бронь расталды: ${when}. Егер өзгерту керек болса, хабарласыңыз.`,
    ru: (name?`${name}, `:'') + `бронь подтверждена: ${when}. Если нужно изменить время — напишите.`,
    en: (name?`${name}, `:'') + `your booking is confirmed: ${when}. If you need to reschedule, just text me.`
  };
  const fb = FALLBACK[lang] || FALLBACK.ru;

  const key = (openaiKey || '').trim();
  if (!key) return fb;

  try {
    const openai = new OpenAI({ apiKey: key });
    const sys = [
      'Ты пишешь короткое подтверждение записи в мессенджере.',
      'Пиши на заданном языке, дружелюбно и по делу, 1–2 предложения, без эмодзи.',
      'Встраивай готовую строку WHEN как есть (не меняй формат).'
    ].join(' ');
    const user = [
      `LANG=${lang}`,
      name ? `NAME=${name}` : '',
      `WHEN=${when}`,
      `TZ=${tz}`
    ].filter(Boolean).join('\n');

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 90,
      messages: [
        { role:'system', content: sys },
        { role:'user',   content: user }
      ]
    });
    const text = (r.choices?.[0]?.message?.content || '').trim();
    return text || fb;
  } catch {
    return fb;
  }
}

// -------------------------------------------------
// DB
// -------------------------------------------------
const DB_PATH = path.join(__dirname, 'db.sqlite');
console.log('DB PATH =', DB_PATH);

const DB = new sqlite3.Database(DB_PATH);
const db = DB;

// ---- SQLite performance & reliability ----
db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL`);        // быстрые чтения/записи
  db.run(`PRAGMA synchronous=NORMAL`);      // безопасно + быстрее (для WAL)
  db.run(`PRAGMA busy_timeout=5000`);       // не падать при конкуренции (5s)
  db.run(`PRAGMA temp_store=MEMORY`);
  db.run(`PRAGMA cache_size=-200000`);      // ~200MB cache (отрицательное = KB)
  db.run(`PRAGMA mmap_size=268435456`);     // 256MB mmap (можно поднять позже)
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((res, rej) =>
    DB.run(sql, params, function (err) {
      if (err) rej(err);
      else res(this);
    })
  );
}

function all(sql, params = []) {
  return new Promise((res, rej) =>
    DB.all(sql, params, (err, rows) => {
      if (err) rej(err);
      else res(rows);
    })
  );
}

function get(sql, params = []) {
  return new Promise((res, rej) =>
    DB.get(sql, params, (err, row) => {
      if (err) rej(err);
      else res(row);
    })
  );
}

async function ensureCol(table, col, type){
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === col)) await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

async function initSaaS(){
  await run(`CREATE TABLE IF NOT EXISTS tenants(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    created_at INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    email TEXT UNIQUE,
    pass_hash TEXT,
    role TEXT,
    created_at INTEGER
  )`);

  // --- Email verification fields (safe migration) ---
  await ensureCol('users', 'email_verified', 'INTEGER DEFAULT 0');
  await ensureCol('users', 'verify_token_hash', 'TEXT');
  await ensureCol('users', 'verify_expires', 'INTEGER');
  await ensureCol('users', 'verify_sent_at', 'INTEGER');

  // --- Password reset fields (safe migration) ---
  await ensureCol('users', 'reset_token_hash', 'TEXT');
  await ensureCol('users', 'reset_expires', 'INTEGER');
  await ensureCol('users', 'reset_sent_at', 'INTEGER');

  await ensureCol('users', 'avatar_url', 'TEXT');
  await ensureCol('users', 'disabled', 'INTEGER DEFAULT 0');

  // --- OAuth fields (Google / Apple) ---
  await ensureCol('users', 'google_sub', 'TEXT');
  await ensureCol('users', 'apple_sub', 'TEXT');
  await ensureCol('users', 'oauth_name', 'TEXT');
  await ensureCol('users', 'oauth_picture', 'TEXT');

  // (не обязательно, но полезно)
  await run(`CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_apple_sub  ON users(apple_sub)`);

  // чтобы старые аккаунты не заблокировались после обновления
  await run(`UPDATE users SET email_verified=1 WHERE email_verified IS NULL`);

  await run(`
    UPDATE users
    SET email_verified=1
    WHERE email_verified=0
      AND (verify_token_hash IS NULL OR verify_token_hash = '')
      AND (verify_sent_at IS NULL OR verify_sent_at = 0)
  `);

  await run(`CREATE TABLE IF NOT EXISTS api_keys(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    label TEXT,
    key TEXT UNIQUE,
    active INTEGER DEFAULT 1,
    created_at INTEGER
  )`);
    // --- Admin notifications (global, per user) ---
  await run(`CREATE TABLE IF NOT EXISTS admin_notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER,
    admin_user_id INTEGER,
    text TEXT NOT NULL,
    image_url TEXT,
    send_all INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS admin_notify_targets(
    notify_id INTEGER,
    user_id INTEGER,
    PRIMARY KEY(notify_id, user_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS admin_notify_views(
    notify_id INTEGER,
    user_id INTEGER,
    seen_at INTEGER,
    PRIMARY KEY(notify_id, user_id)
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_admin_notify_views_notify ON admin_notify_views(notify_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_admin_notify_targets_user ON admin_notify_targets(user_id)`);
  
    // --- Analytics (site-wide) ---
  await run(`CREATE TABLE IF NOT EXISTS analytics_sessions(
    sid TEXT PRIMARY KEY,
    aid TEXT,
    first_seen INTEGER,
    last_seen INTEGER,
    country TEXT,
    ref_host TEXT,
    ref_full TEXT,
    path_first TEXT,
    ua TEXT,
    browser TEXT,
    device TEXT,
    ip_hash TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS analytics_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    sid TEXT,
    aid TEXT,
    type TEXT,
    path TEXT,
    ref_host TEXT,
    country TEXT,
    browser TEXT,
    device TEXT
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_ae_ts ON analytics_events(ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ae_type_ts ON analytics_events(type, ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ae_path_ts ON analytics_events(path, ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_as_last_seen ON analytics_sessions(last_seen)`);

  const tc = await get(`SELECT COUNT(*) c FROM tenants`);
  if(Number(tc?.c||0)===0){
    await run(`INSERT INTO tenants(name,created_at) VALUES(?,?)`, ['Default', Date.now()]);
  }

  // ---------------- Tariff plans (global) ----------------
  await run(`CREATE TABLE IF NOT EXISTS tariff_plans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    price_kzt INTEGER DEFAULT 0,
    wa_max INTEGER DEFAULT 10,
    tg_max INTEGER DEFAULT 999,
    feature_mask INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

}


// -------------------------------------------------
// DB migration: profiles table compatibility
// Older DBs might miss profiles.acc_id and/or have PK (tenant_id,jid).
// We migrate to PK (tenant_id, acc_id, jid) and keep existing rows under acc_id=0.
// -------------------------------------------------
async function migrateProfilesTableIfNeeded() {
  try {
    const info = await all(`PRAGMA table_info(profiles)`);
    if (!Array.isArray(info) || info.length === 0) return;

    const cols = info.map(r => String(r.name || ''));
    const pkCols = info
      .filter(r => Number(r.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map(r => String(r.name || ''));

    const hasAcc = cols.includes('acc_id');
    const pkOk = (pkCols.length === 3 && pkCols[0] === 'tenant_id' && pkCols[1] === 'acc_id' && pkCols[2] === 'jid');

    if (hasAcc && pkOk) return;

    console.log('[DB][MIGRATE] profiles → add acc_id + PK(tenant_id, acc_id, jid)');

    await run('BEGIN IMMEDIATE');
    try {
      await run(`ALTER TABLE profiles RENAME TO profiles_old`);

      await run(`CREATE TABLE IF NOT EXISTS profiles(
        tenant_id INTEGER,
        acc_id INTEGER,
        jid TEXT,
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
        PRIMARY KEY (tenant_id, acc_id, jid)
      )`);

  // ✅ migrate older DB schemas (profiles without acc_id / wrong PK)
  await migrateProfilesTableIfNeeded();

      const oldInfo = await all(`PRAGMA table_info(profiles_old)`);
      const oldCols = new Set((oldInfo || []).map(r => String(r.name || '')));

      const destCols = [
        'tenant_id','acc_id','jid','name','city','budget','interest','notes','lang',
        'last_intent','summary','stage','slots_updated_at','crm_id','crm_url'
      ];

      const sel = destCols.map(c => {
        if (c === 'acc_id') return oldCols.has('acc_id') ? 'COALESCE(acc_id,0) AS acc_id' : '0 AS acc_id';
        if (oldCols.has(c)) return c;
        if (c === 'tenant_id') return '0 AS tenant_id';
        if (c === 'jid') return "'' AS jid";
        return `NULL AS ${c}`;
      }).join(', ');

      await run(`INSERT INTO profiles(${destCols.join(',')}) SELECT ${sel} FROM profiles_old`);

      await run(`DROP TABLE profiles_old`);

      await run(`CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc ON profiles(tenant_id, acc_id)`);
      await run(`CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc_jid ON profiles(tenant_id, acc_id, jid)`);

      await run('COMMIT');
      console.log('[DB][MIGRATE] profiles: done');
    } catch (e) {
      try { await run('ROLLBACK'); } catch (_) {}
      console.error('[DB][MIGRATE] profiles failed:', e?.message || e);
    }
  } catch (e) {
    console.error('[DB][MIGRATE] profiles check failed:', e?.message || e);
  }
}

// -------------------------------------------------
// DB migration: admin_notifications compatibility
// Older DBs had columns: created_at, admin_user_id, text, image_url, send_all
// Newer code expects: text, image_file, target_all, is_active, created_by, created_at
// And uses tables admin_notification_targets/admin_notification_views.
// -------------------------------------------------
async function migrateAdminNotificationsIfNeeded(){
  try{
    const info = await all(`PRAGMA table_info(admin_notifications)`);
    if(!Array.isArray(info) || info.length === 0) return;
    const cols = new Set(info.map(r=>String(r.name||'')));

    // add missing columns (safe on old schema)
    if(!cols.has('image_file')) await run(`ALTER TABLE admin_notifications ADD COLUMN image_file TEXT`);
    if(!cols.has('target_all')) await run(`ALTER TABLE admin_notifications ADD COLUMN target_all INTEGER DEFAULT 0`);
    if(!cols.has('is_active'))  await run(`ALTER TABLE admin_notifications ADD COLUMN is_active  INTEGER DEFAULT 1`);
    if(!cols.has('created_by')) await run(`ALTER TABLE admin_notifications ADD COLUMN created_by INTEGER`);

    // backfill from old column names if they exist
    const info2 = await all(`PRAGMA table_info(admin_notifications)`);
    const cols2 = new Set((info2||[]).map(r=>String(r.name||'')));
    if(cols2.has('image_url')){
      await run(`UPDATE admin_notifications SET image_file = COALESCE(image_file, image_url) WHERE image_url IS NOT NULL AND (image_file IS NULL OR image_file='')`);
    }
    if(cols2.has('send_all')){
      await run(`UPDATE admin_notifications SET target_all = COALESCE(target_all, send_all) WHERE send_all IS NOT NULL`);
    }
    if(cols2.has('admin_user_id')){
      await run(`UPDATE admin_notifications SET created_by = COALESCE(created_by, admin_user_id) WHERE admin_user_id IS NOT NULL`);
    }
    await run(`UPDATE admin_notifications SET is_active = COALESCE(is_active,1) WHERE is_active IS NULL`);
    await run(`UPDATE admin_notifications SET target_all = COALESCE(target_all,0) WHERE target_all IS NULL`);

    // migrate old target/view tables into new ones (if present)
    const tOld = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_notify_targets'`);
    const vOld = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_notify_views'`);
    const tNew = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_notification_targets'`);
    const vNew = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_notification_views'`);
    if(tOld && tNew){
      await run(`INSERT OR IGNORE INTO admin_notification_targets(notif_id, user_id)
                 SELECT notify_id, user_id FROM admin_notify_targets`);
    }
    if(vOld && vNew){
      await run(`INSERT OR IGNORE INTO admin_notification_views(notif_id, user_id, seen_at)
                 SELECT notify_id, user_id, seen_at FROM admin_notify_views`);
    }
  }catch(e){
    console.warn('[DB][MIGRATE] admin_notifications skipped:', e?.message || e);
  }
}

async function initDB(){

  // ⭐ Таблица для хранения message retry counter (fix "Waiting for message")
  await run(`
    CREATE TABLE IF NOT EXISTS wa_msg_retry_counter(
      acc_id INTEGER,
      msg_id TEXT,
      retry_count INTEGER DEFAULT 0,
      updated_at INTEGER,
      PRIMARY KEY(acc_id, msg_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_wa_retry_acc ON wa_msg_retry_counter(acc_id)`);


  // ⭐ WhatsApp LID mapping: lid -> real phone jid (safe, verified)
  await run(`
    CREATE TABLE IF NOT EXISTS lid_mapping(
      acc_id INTEGER,
      lid TEXT,
      phone_jid TEXT,
      phone_number TEXT,
      is_verified INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      PRIMARY KEY(acc_id, lid)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_lid_mapping_phone ON lid_mapping(phone_jid)`);

  await run(`CREATE TABLE IF NOT EXISTS accounts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    label TEXT, folder TEXT, me_jid TEXT, status TEXT,
    wa_engine TEXT DEFAULT 'baileys',
    model TEXT, temperature REAL, max_tokens INTEGER, forced_lang TEXT,
    ai_enabled INTEGER DEFAULT 1,
    kind TEXT DEFAULT 'wa',
    tg_token TEXT,
    tg_username TEXT,
    tg_offset INTEGER DEFAULT 0,
    created_at INTEGER, updated_at INTEGER
  )`);

  // ⭐ WABA: Добавляем колонки для WhatsApp Business API (Meta Cloud API)
  try {
    await run(`ALTER TABLE accounts ADD COLUMN waba_enabled INTEGER DEFAULT 0`);
  } catch (e) {
    // Колонка уже существует
  }
  
  try {
    await run(`ALTER TABLE accounts ADD COLUMN waba_phone_number_id TEXT`);
  } catch (e) {
    // Колонка уже существует
  }
  
  try {
    await run(`ALTER TABLE accounts ADD COLUMN waba_access_token TEXT`);
  } catch (e) {
    // Колонка уже существует
  }

  // ✅ WABA provider: meta(manual) / gupshup(auto)
  try { await run(`ALTER TABLE accounts ADD COLUMN waba_provider TEXT DEFAULT 'meta'`); } catch(e) {}

  // ✅ Gupshup auto fields
  try { await run(`ALTER TABLE accounts ADD COLUMN gupshup_app_id TEXT`); } catch(e) {}
  try { await run(`ALTER TABLE accounts ADD COLUMN gupshup_app_token TEXT`); } catch(e) {}
  try { await run(`ALTER TABLE accounts ADD COLUMN gupshup_status TEXT`); } catch(e) {}

  // ✅ WhatsApp engine: baileys
  try { await run(`ALTER TABLE accounts ADD COLUMN wa_engine TEXT DEFAULT 'baileys'`); } catch(e) {}
  try { await run(`UPDATE accounts SET wa_engine='baileys' WHERE wa_engine IS NULL OR wa_engine=''`); } catch(e) {}

  // на всякий: заполнить старым аккаунтам provider
  try { await run(`UPDATE accounts SET waba_provider='meta' WHERE waba_provider IS NULL OR waba_provider=''`); } catch(e) {}
  
  try {
    await run(`ALTER TABLE accounts ADD COLUMN phone TEXT`);
  } catch (e) {
    // Колонка уже существует
  }

    // ---------------- Instagram (separate module) ----------------
  await run(`CREATE TABLE IF NOT EXISTS ig_connections(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER UNIQUE,
    page_id TEXT,
    ig_user_id TEXT,
    username TEXT,
    access_token TEXT,
    token_expires_at INTEGER,
    connected_at INTEGER,
    status TEXT DEFAULT 'connected',
    last_error TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS ig_chats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    thread_id TEXT,
    from_id TEXT,
    ts INTEGER,
    direction TEXT, -- 'in' | 'out'
    text TEXT,
    raw_json TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS ig_chat_state(
    tenant_id INTEGER,
    thread_id TEXT,
    is_active INTEGER DEFAULT 1,
    updated_at TEXT,
    PRIMARY KEY (tenant_id, thread_id)
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_ig_chats_tenant_thread ON ig_chats(tenant_id, thread_id, ts)`);

  await run(`CREATE TABLE IF NOT EXISTS chats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    jid TEXT, date TEXT, ts INTEGER, message TEXT, type TEXT, acc_id INTEGER,
    media_file TEXT, media_kind TEXT
  )`);

  // --- Reactions overlay (for WA/TG/IG visual reactions) ---
  await run(`CREATE TABLE IF NOT EXISTS msg_reactions(
    tenant_id INTEGER,
    acc_id INTEGER,
    jid TEXT,
    msg_ref TEXT,
    reactions_json TEXT,
    updated_at INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid, msg_ref)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_msg_reactions_lookup ON msg_reactions(tenant_id, acc_id, jid, msg_ref)`);

  // ---- Controlled delete: allow deleting chat history only via guarded endpoint ----
  await run(`CREATE TABLE IF NOT EXISTS delete_guard(
    tenant_id INTEGER,
    acc_id INTEGER,
    jid TEXT,
    until_ts INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid)
  )`);

  // ---- HARD protection: forbid deleting chat history (except when delete_guard allows it) ----
  // Миграция: раньше триггеры всегда запрещали DELETE. Теперь разрешаем только когда есть запись в delete_guard.
  await run(`DROP TRIGGER IF EXISTS trg_no_delete_chats`);
  await run(`DROP TRIGGER IF EXISTS trg_no_delete_ig_chats`);

  await run(`
    CREATE TRIGGER IF NOT EXISTS trg_no_delete_chats
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
  `);

  await run(`
    CREATE TRIGGER IF NOT EXISTS trg_no_delete_ig_chats
    BEFORE DELETE ON ig_chats
    BEGIN
      SELECT CASE
        WHEN EXISTS(
          SELECT 1 FROM delete_guard
          WHERE tenant_id=OLD.tenant_id
            AND jid=('ig:'||OLD.thread_id)
            AND (until_ts IS NULL OR until_ts > CAST(strftime('%s','now') AS INTEGER))
        )
        THEN NULL
        ELSE RAISE(ABORT, 'IG chat history delete is disabled')
      END;
    END;
  `);

  await run(`CREATE TABLE IF NOT EXISTS settings(
    tenant_id INTEGER, key TEXT, value TEXT,
    PRIMARY KEY(tenant_id, key)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS blocks(
    tenant_id INTEGER, jid TEXT, until INTEGER,
    PRIMARY KEY(tenant_id, jid)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS followups(
    tenant_id INTEGER, acc_id INTEGER, jid TEXT, step INTEGER, sent_ts INTEGER,
    PRIMARY KEY(tenant_id, acc_id, jid, step)
  )`);

    // --- First message template (state + jobs) ---
  await run(`CREATE TABLE IF NOT EXISTS firstmsg_state(
    tenant_id INTEGER, acc_id INTEGER, jid TEXT,
    state TEXT,                 -- pending | sent | done
    created_ts INTEGER,
    sent_ts INTEGER,
    done_ts INTEGER,
    PRIMARY KEY(tenant_id, acc_id, jid)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS firstmsg_jobs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER, acc_id INTEGER, jid TEXT,
    due_ts INTEGER,
    status TEXT,                -- pending | sent | failed
    text TEXT,
    media_file TEXT,
    media_kind TEXT,
    created_ts INTEGER,
    sent_ts INTEGER,
    attempts INTEGER DEFAULT 0,
    last_try_ts INTEGER DEFAULT 0
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_firstmsg_jobs_due ON firstmsg_jobs(status, due_ts)`);

  await run(`CREATE TABLE IF NOT EXISTS profiles(
    tenant_id INTEGER, acc_id INTEGER, jid TEXT,
    name TEXT, city TEXT, budget TEXT, interest TEXT,
    notes TEXT, lang TEXT, last_intent TEXT, summary TEXT,
    stage TEXT,
    slots_updated_at INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS contacts(
    acc_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    push_name TEXT DEFAULT '',
    notify TEXT DEFAULT '',
    updated_at INTEGER DEFAULT 0,
    PRIMARY KEY (acc_id, jid)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS escalations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER, acc_id INTEGER, jid TEXT, reason TEXT, text TEXT, ts INTEGER, resolved INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS msg_templates(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    title TEXT, body TEXT,
    media_file TEXT, media_kind TEXT,
    created_at INTEGER, updated_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS receipts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    acc_id INTEGER,
    jid TEXT,
    ts INTEGER,
    amount REAL,
    currency TEXT,
    file TEXT,         -- путь к файлу (uploads/....)
    raw_text TEXT      -- распарсенный текст
  )`);

  await run(`CREATE TABLE IF NOT EXISTS kb_files(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    filename TEXT,         -- uploads/xxx.xlsx (оригинал)
    title TEXT,            -- удобное имя (обычно имя файла)
    file_kind TEXT,        -- 'xlsx' | 'csv' | 'txt' (пока xlsx)
    uploaded_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS kb_chunks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    file_id INTEGER,
    chunk_index INTEGER,
    text TEXT,             -- сам фрагмент
    tokens INTEGER,        -- оценка длины
    embedding TEXT         -- JSON массива чисел (вектор)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tg_sent(
    tenant_id INTEGER,
    event TEXT,
    jid TEXT,
    ts INTEGER,
    PRIMARY KEY (tenant_id, event, jid)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS campaigns(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    acc_id INTEGER,                 -- через какой WA-акк слать
    title TEXT,
    text TEXT,
    media_file TEXT,
    media_kind TEXT,                -- '' | 'image' | 'video'
    created_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    status TEXT,                    -- 'draft'|'running'|'paused'|'done'|'error'
    settings_json TEXT              -- JSON антибана (скорости/окна)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS campaign_targets(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    campaign_id INTEGER,
    jid TEXT,                       -- 77001234567@s.whatsapp.net
    status TEXT,                    -- 'queued'|'sent'|'failed'|'skipped'
    error TEXT,
    sent_ts INTEGER,
    reply_ts INTEGER,               -- когда пришёл первый ответ
    unique(jid, campaign_id) ON CONFLICT IGNORE
  )`);

  // --- SatuCoin: кошелёк по tenant и история операций ---
  await run(`CREATE TABLE IF NOT EXISTS satu_wallets(
    tenant_id INTEGER PRIMARY KEY,
    balance   INTEGER NOT NULL DEFAULT 0, -- баланс в SatuCoin (1 coin = 1 тг)
    updated_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS satu_transactions(
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id   INTEGER,          -- кто сделал операцию (админ), может быть NULL
    amount    INTEGER NOT NULL, -- +N или -N SatuCoin
    reason    TEXT,             -- 'admin_topup', 'ai_reply' и т.д.
    meta      TEXT,             -- JSON с деталями (jid, acc_id...)
    created_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS satu_leads(
    tenant_id INTEGER NOT NULL,
    acc_id    INTEGER NOT NULL,
    jid       TEXT    NOT NULL,
    month_key TEXT    NOT NULL,   -- '2025-12' формат
    first_ts  INTEGER NOT NULL,   -- когда впервые списали за этого лида в этом месяце
    PRIMARY KEY (tenant_id, acc_id, jid, month_key)
  )`);

    // --- Admin notifications (глобальные уведомления админа) ---
  await run(`CREATE TABLE IF NOT EXISTS admin_notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    image_file TEXT,
    target_all INTEGER DEFAULT 0,
    is_active  INTEGER DEFAULT 1,
    created_by INTEGER,
    created_at INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS admin_notification_targets(
    notif_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    PRIMARY KEY (notif_id, user_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS admin_notification_views(
    notif_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    seen_at  INTEGER,
    PRIMARY KEY (notif_id, user_id)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_admin_notif_active ON admin_notifications(is_active, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_admin_notif_targets_user ON admin_notification_targets(user_id, notif_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_admin_notif_views_user ON admin_notification_views(user_id, notif_id)`);

  // ✅ make old/new schemas compatible (older DBs had image_url/send_all/admin_user_id)
  await migrateAdminNotificationsIfNeeded();

  await ensureCol('accounts','tenant_id','INTEGER');
  await ensureCol('chats','tenant_id','INTEGER');
  await ensureCol('blocks','tenant_id','INTEGER');
  await ensureCol('followups','tenant_id','INTEGER');
  await ensureCol('profiles','tenant_id','INTEGER');
  await ensureCol('escalations','tenant_id','INTEGER');
  await ensureCol('msg_templates','tenant_id','INTEGER');
  await ensureCol('chats','media_file','TEXT');
  await ensureCol('chats','media_kind','TEXT');
  await ensureCol('profiles','crm_id','TEXT');
  await ensureCol('profiles','crm_url','TEXT');
  await ensureCol('chats','wa_id','TEXT');
  await ensureCol('chats','status','TEXT');

  await ensureCol('chats','media_name','TEXT');
  await ensureCol('chats','media_mime','TEXT');
  await ensureCol('chats','media_size','INTEGER');

  await run(`CREATE TABLE IF NOT EXISTS msg_reactions(
    tenant_id INTEGER,
    acc_id INTEGER,
    jid TEXT,
    msg_ref TEXT,
    reactions_json TEXT,
    updated_at INTEGER,
    PRIMARY KEY (tenant_id, acc_id, jid, msg_ref)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_msg_reactions_lookup ON msg_reactions(tenant_id, acc_id, jid, msg_ref)`);

  // --- AI usage / cost fields (для точных токенов и $) ---
  await ensureCol('chats','crm_ext_id','TEXT');
  await ensureCol('chats','prompt_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','completion_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','total_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','model','TEXT');

  await ensureCol('chats','cost_usd_in','REAL DEFAULT 0');
  await ensureCol('chats','cost_usd_out','REAL DEFAULT 0');
  await ensureCol('chats','cost_usd_total','REAL DEFAULT 0');
  await ensureCol('chats','cost_usd','REAL DEFAULT 0'); // совместимость

  await ensureCol('accounts','ai_enabled','INTEGER DEFAULT 1');
  await ensureCol('accounts','ai_enabled_prev','INTEGER');

  await ensureCol('accounts','kind','TEXT', 'wa');
  await ensureCol('accounts','tg_token','TEXT', null);
  await ensureCol('accounts','tg_username','TEXT', null);
  await ensureCol('accounts','tg_offset','INTEGER', 0);

  await ensureCol('chats', 'campaign_id', 'INTEGER');
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_tenant_campaign_ts ON chats(tenant_id, campaign_id, ts)`);

  await ensureCol('campaigns','processing','INTEGER DEFAULT 0');
  await run(`CREATE INDEX IF NOT EXISTS idx_campaigns_status_proc ON campaigns(status, processing)`);

  await ensureCol('campaigns','processing_ts','INTEGER DEFAULT 0');
  await run(`CREATE INDEX IF NOT EXISTS idx_campaigns_proc_ts ON campaigns(processing, processing_ts)`);

  await ensureCol('chats','prompt_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','completion_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','total_tokens','INTEGER DEFAULT 0');
  await ensureCol('chats','model','TEXT');
  
  await ensureCol('chats','cost_usd','REAL DEFAULT 0');

  await ensureCol('chats','crm_ext_id','TEXT');

  await ensureCol('chats','cost_usd_in','REAL DEFAULT 0');
  await ensureCol('chats','cost_usd_out','REAL DEFAULT 0');
  await ensureCol('chats','cost_usd_total','REAL DEFAULT 0');
  await ensureCol('chats','openai_req_id','TEXT');

  // --- AI reply idempotency (prevents duplicate replies to the same incoming WA message)
  await run(`
    CREATE TABLE IF NOT EXISTS ai_reply_dedup(
      tenant_id INTEGER NOT NULL,
      acc_id    INTEGER NOT NULL,
      jid       TEXT    NOT NULL,
      in_wa_id   TEXT    NOT NULL,
      created_ts INTEGER NOT NULL,
      out_ext_id TEXT,
      PRIMARY KEY (tenant_id, acc_id, jid, in_wa_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_reply_dedup_created ON ai_reply_dedup(tenant_id, created_ts)`);

  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_tenant_crmext
    ON chats(tenant_id, crm_ext_id)
    WHERE crm_ext_id IS NOT NULL
  `);

  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_wa
    ON chats(tenant_id, acc_id, jid, wa_id)
    WHERE wa_id IS NOT NULL
  `);
  
  await setSetting('broadcast_rate_per_min', '8',            1);  // сколько сообщений/мин
  await setSetting('broadcast_batch_size',   '20',           1);  // после каждой пачки уснуть
  await setSetting('broadcast_sleep_ms_min', '1200',         1);  // пауза между сообщениями, минимум
  await setSetting('broadcast_sleep_ms_max', '3500',         1);  // пауза между сообщениями, максимум
  await setSetting('broadcast_big_sleep_ms', '45000',        1);  // пауза после пачки
  await setSetting('broadcast_daily_cap',    '400',          1);  // дневной потолок для акка
  await setSetting('broadcast_work_from',    '09:00',        1);  // рабочие часы по локали
  await setSetting('broadcast_work_to',      '21:00',        1);

  // === Indexes for high-throughput ===
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_tenant_ts          ON chats(tenant_id, ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_tenant_type_ts     ON chats(tenant_id, type, ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_acc_type_ts        ON chats(acc_id, type, ts)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_tenant_acc_jid_ts  ON chats(tenant_id, acc_id, jid, ts)`);

  // Faster history: ORDER BY ts DESC, id DESC
  await run(`CREATE INDEX IF NOT EXISTS idx_chats_hist_fast ON chats(tenant_id, acc_id, jid, ts DESC, id DESC)`);

  // Faster IG history: ORDER BY ts DESC
  await run(`CREATE INDEX IF NOT EXISTS idx_ig_chats_hist_fast ON ig_chats(tenant_id, thread_id, ts DESC, id DESC)`);



  await run(`CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc      ON profiles(tenant_id, acc_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_profiles_tenant_acc_jid  ON profiles(tenant_id, acc_id, jid)`);

  await run(`CREATE INDEX IF NOT EXISTS idx_campaign_targets_pick    ON campaign_targets(tenant_id, campaign_id, status, id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_campaign_targets_lookup  ON campaign_targets(tenant_id, jid, status)`);

  await run(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant         ON kb_chunks(tenant_id)`);

  await run(`CREATE INDEX IF NOT EXISTS idx_followups_tenant_acc_jid ON followups(tenant_id, acc_id, jid)`);

  const backfill = async (t)=> await run(`UPDATE ${t} SET tenant_id=1 WHERE tenant_id IS NULL`);
  for (const t of ['accounts','chats','blocks','followups','profiles','escalations','msg_templates']) await backfill(t);

  const hasAnySet = await get(`SELECT COUNT(*) c FROM settings WHERE tenant_id=1`);
  if(Number(hasAnySet?.c||0)===0){
    const def = [
      ['system_prompt','Ты вежливый WhatsApp-ассистент. Отвечай кратко, дружелюбно и по делу.'],
      ['delay_sec','2'],
      ['stopword','стоп'],
      ['startword','включить'],
      ['block_time_min','60'],
      ['followup_enabled','1'],
      ['followup_steps','[]'],
      ['ctx_messages','12'],
      ['summary_every_n','8'],
      ['lang_auto','1'],
      ['slots_enabled','1'],
      ['blacklist_phrases','["не пишите","удалите номер","stop","отпишитесь"]'],
      ['whitelist_phrases','["подробнее","давайте","интересно","хочу","купить"]'],
      ['moderation_enabled','1'],
      ['moderation_badwords','["оскорб","брань","18+","политика"]'],
      ['escalate_after_out_no_reply','3'],
      ['escalation_webhook',''],
      ['telegram_token',''],
      ['telegram_chat',''],
      ['telegram_events','["booked","human_needed","no_reply_after_many_out"]'],
      ['default_model','gpt-4o'],
      ['default_temperature','0.7'],
      ['default_max_tokens','200'],
      ['receipt_ocr_enabled','0'],
      ['default_max_tokens_enabled','0'],    // 0 = галочка выключена
      ['fu_gate_enabled','1'],
      ['fu_done_phrases','["записал","записала","забронировал","забронировала","бронь есть","забронировали","записались","записалась","подтверждаю","подтвердил","подтвердила","подтверждено","оформил","оформила","оформлено","готово","сделано","оплатил","оплатила","оплата прошла","оплата поступила","пришла оплата","перевел","перевела","скинул деньги","внес предоплату","предоплата внесена","аванс внесен","аванс внесла","заказ оплачен","частично оплатил","частично оплатила","буду","приеду","иду","еду","пришла","пришел","сегодня буду","подойду","подъеду","брон жасалды","бронь жасалды","брон жасадым","бронь жасадым","брон қойдым","бронь қойдық","белгіледім","жазып қойдым","келем","келемін","келемыз","растаймын","растадым","төледім","төлем жасалды","төлем жібердім","аванс салдым","ақша түсті","тапсырыс рәсімделді","брon jasaldy","bron jasaldy","bron qoydym","toledim","tolem jasaldy","aqsha tusti","rastaimyn","booked","i booked","reservation made","reserved","scheduled","appointment booked","confirmed","i confirm","payment done","payment completed","paid","i paid","paid deposit","deposit made","prepayment made","order placed","order confirmed","done","all set","on my way","i will come","i will be there"]'],
      ['fu_no_follow_phrases','["не интересно","неинтересно","не актуально","неактуально","не нужно","мне не нужно","не пригодится","не подходит","дорого","откажусь","отказываюсь","отказ","передумал","передумала","больше не пишите","не пишите","удалите номер","удалить номер","стоп","стоп слово","хватит","не беспокоить","не беспокойте","не звоните","не звонить","не писать","не надо","отписка","спам","заблокирую","қызық емес","қажет емес","өзікті емес","өзекті емес","керек емес","қымбат","бас тартамын","бас тарттым","ойым өзгерді","жазбаңыз","жазбаңыздар","нөмірімді өшіріңіз","нөмірді өшіріңіз","тоқта","мазаламаңыз","қоңырау шалмаңыз","qyzıq emes","kerек emes","bas tartamyn","nomerimdi oshiriniz","toqta","mazalamanyz","not interested","no longer interested","not relevant","not needed","doesn’t fit","too expensive","i’ll pass","i pass","decline","changed my mind","don’t contact me","do not contact","don’t text me","don’t call me","stop","unsubscribe","remove my number","delete my number","no spam","spam","block me"]'],
      ['open_signup','1'],
      ['open_signup_role','user'],
      ['ai_fup_enabled','1'],
      ['ai_fup_model','gpt-4o-mini'],
      ['ai_fup_temperature','0.5'],
      ['ai_fup_max_tokens','220'],
      ['kb_enabled','1'],
      ['kb_top_k','5'],
      ['public_base_url',''],
      ['tts_enabled','0'],                 // 0|1 — вкл/выкл TTS на аккаунте
      ['tts_mode','both'],                 // 'both' | 'voice_only'
      ['tts_model','gpt-4o-mini-tts'],     // модель озвучки
      ['tts_voice','alloy'],               // голос (alloy, verse, aria, coral и т.п.)
      ['tts_lang',''],                   // подсказка языку (ru|kk|en)
      ['tts_rate','1.0'],                  // скорость (0.8–1.2)
      ['tts_pitch','0'],                   // полутоновое смещение, строкой: '-2'...'2'
      ['first_message_enabled','0'],
      ['first_message_delay_sec','2'],
      ['first_message_text',''],
      ['first_message_media_file',''],
      ['first_message_media_kind',''],

      // ---- Instagram agent defaults (separate keys) ----
      ['ig_system_prompt','Ты вежливый Instagram-ассистент. Отвечай кратко, дружелюбно и по делу.'],
      ['ig_delay_sec','2'],
      ['ig_stopword',''],
      ['ig_startword',''],
      ['ig_block_time_min','0'],
      ['ig_allow_direct','1'],
      ['ig_allow_comments','1'],
      ['ig_allow_comment_dm','0'],
      ['ig_allow_story_mentions','1'],
      ['ig_allow_post_mentions','1'],
      ['ig_stoplist',''],                 // @username или id, каждый с новой строки
      ['ig_ctx_messages','18'],           // контекст сообщений

    ];
    for (const [k,v] of def){ await run(`INSERT OR REPLACE INTO settings(tenant_id,key,value) VALUES(1,?,?)`,[k,v]); }
  }

  const cnt = await get(`SELECT COUNT(*) c FROM accounts`);
  if (!cnt || !cnt.c) {
    await run(`INSERT INTO accounts(tenant_id,label,folder,status,model,temperature,max_tokens,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)`,
               [1,'Основной','auth','offline','gpt-4o',0.7,200,Date.now(),Date.now()]);
  }
}

// settings helpers (per-tenant)
async function getSetting(key, tenantId) {
  return await new Promise((resolve) => {
    DB.get(
      `SELECT value FROM settings WHERE tenant_id=? AND key=?`,
      [tenantId, key],
      (err, row) => {
        if (err) {
          console.log('[getSetting] err', err);
        }

        let val = row ? row.value : '';

        // ✅ ВАЖНО: fallback на .env для общего ключа OpenAI (если в базе пусто)
        if ((!val || String(val).trim() === '') && key === 'openai_key') {
          val =
            process.env.OPENAI_API_KEY ||
            process.env.OPENAI_KEY ||
            process.env.OPENAI_TOKEN ||
            '';
        }

        resolve(val || '');
      }
    );
  });
}

async function setSetting(key, value, tenantId){
  await run(`INSERT OR REPLACE INTO settings(tenant_id,key,value) VALUES(?,?,?)`, [tenantId,key,value]);
}

// ---------------- Entitlements (features + limits) ----------------
const FEATURES = {
  FOLLOWUP_TEMPLATE: 1 << 0,
  FOLLOWUP_AI:       1 << 1,
  BROADCAST:         1 << 2,
  KB:                1 << 3,
  TG_INTEGRATION:    1 << 5,
  CRM:               1 << 6,

  SET_PROMPT:        1 << 7,
  SET_FIRSTMSG:      1 << 8,
  SET_TTS:           1 << 9,
  SET_AI_MOD:        1 << 10,
  SET_STOPLIST:      1 << 11,
  SET_DEFAULT_MAX:   1 << 12,
  SET_RECEIPTS_PDF:  1 << 13,
};
const FEATURE_ALL = Object.values(FEATURES).reduce((a,b)=>a|b,0);

function maskHas(mask, bit){ return ((Number(mask)||0) & bit) === bit; }
function maskHasAny(mask, bits){ return (((Number(mask)||0) & bits) !== 0); }

async function getTenantEntitlements(tenantId){
  const tid = Number(tenantId||0);

  // defaults: всё включено
  const rawMask = await getSetting('ent_feature_mask', tid);
  let feature_mask =
    (rawMask === null || rawMask === undefined || rawMask === '')
      ? FEATURE_ALL
      : Number(rawMask);


  let wa_max = await getSetting('ent_wa_max', tid);
  wa_max = (wa_max === null || wa_max === '') ? 10 : Number(wa_max);

  let tg_max = await getSetting('ent_tg_max', tid);
  tg_max = (tg_max === null || tg_max === '') ? 999 : Number(tg_max);

  let plan_id = await getSetting('ent_plan_id', tid);
  plan_id = plan_id ? Number(plan_id) : null;

  let plan = null;
  if(plan_id){
    plan = await get(
      'SELECT id,name,price_kzt,wa_max,tg_max,feature_mask FROM tariff_plans WHERE id=?',
      [plan_id]
    );
    if(!plan){
      const legacyName = await getSetting('tariff_plan', tid);
      plan = { id: plan_id, name: legacyName || '', price_kzt: null };
    }
  }else{
    const legacyName = await getSetting('tariff_plan', tid);
    if(legacyName) plan = { id:null, name: legacyName, price_kzt: null };
  }

  const features = {
    followup_template: maskHas(feature_mask, FEATURES.FOLLOWUP_TEMPLATE),
    followup_ai:       maskHas(feature_mask, FEATURES.FOLLOWUP_AI),
    broadcast:         maskHas(feature_mask, FEATURES.BROADCAST),
    kb:                maskHas(feature_mask, FEATURES.KB),
    tg_integration:    maskHas(feature_mask, FEATURES.TG_INTEGRATION),
    crm:               maskHas(feature_mask, FEATURES.CRM),

    set_prompt:        maskHas(feature_mask, FEATURES.SET_PROMPT),
    set_firstmsg:      maskHas(feature_mask, FEATURES.SET_FIRSTMSG),
    set_tts:           maskHas(feature_mask, FEATURES.SET_TTS),
    set_ai_mod:        maskHas(feature_mask, FEATURES.SET_AI_MOD),
    set_stoplist:      maskHas(feature_mask, FEATURES.SET_STOPLIST),
    set_default_max:   maskHas(feature_mask, FEATURES.SET_DEFAULT_MAX),
    set_receipts_pdf:  maskHas(feature_mask, FEATURES.SET_RECEIPTS_PDF),
  };

  return { feature_mask, limits:{ wa_max, tg_max }, plan, features };
}

function requireFeature(bit){
  return async (req,res,next)=>{
    try{
      const ent = await getTenantEntitlements(req.user.tenant_id);
      if(!maskHas(ent.feature_mask, bit)) return res.status(403).json({ ok:false, error:'FEATURE_DISABLED' });
      req.entitlements = ent;
      next();
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  };
}
function requireAnyFeature(bits){
  return async (req,res,next)=>{
    try{
      const ent = await getTenantEntitlements(req.user.tenant_id);
      if(!maskHasAny(ent.feature_mask, bits)) return res.status(403).json({ ok:false, error:'FEATURE_DISABLED' });
      req.entitlements = ent;
      next();
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  };
}

function featureNeededForSettingKey(key){
  if(key === 'prompt') return FEATURES.SET_PROMPT;

  // Instagram settings (separate keys) use same entitlements
  if(key === 'ig_system_prompt') return FEATURES.SET_PROMPT;
  if(key.startsWith('ig_first_message_')) return FEATURES.SET_FIRSTMSG;
  if(key.startsWith('ig_tts_')) return FEATURES.SET_TTS;

  if(key.startsWith('first_message_')) return FEATURES.SET_FIRSTMSG;
  if(key.startsWith('tts_')) return FEATURES.SET_TTS;

  if(key === 'default_model' || key === 'default_temperature' || key === 'moderation_enabled')
    return FEATURES.SET_AI_MOD;

  if(key === 'default_max_tokens') return FEATURES.SET_DEFAULT_MAX;
  if(key === 'receipt_ocr_enabled') return FEATURES.SET_RECEIPTS_PDF;

  return null;
}

async function getAccTenant(accId){
  const n = Number(accId||0);
  // Virtual IG account uses negative id = -tenant_id
  if (n < 0) return Math.abs(n);
  const r = await get(`SELECT tenant_id FROM accounts WHERE id=?`, [n]);
  return Number(r?.tenant_id||0) || 1;
}
async function getAccKind(accId){
  const n = Number(accId||0);
  // Virtual IG account uses negative id = -tenant_id
  if (n < 0) return 'ig';

  const r = await get(`SELECT kind FROM accounts WHERE id=?`, [n]);
  const k = String(r?.kind || 'wa').toLowerCase();

  if (k === 'ig' || k === 'instagram') return 'ig';
  if (k === 'tg' || k === 'telegram') return 'tg';
  return 'wa';
}

// OpenAI key: global for all tenants (hidden from UI/API)
async function getOpenAIKeyForTenant(tenantId){
  const envKey = (process.env.OPENAI_API_KEY || '').trim();
  if (envKey) return envKey;

  // fallback (на случай старых настроек, чтобы не уронить прод)
  const dbKey = (await getSetting('openai_key', tenantId) || '').trim();
  return dbKey;
}

async function getOpenAIPricing(tenantId){
  // пример JSON:
  // {"gpt-4o":{"in":5.00,"out":15.00},"gpt-4o-mini":{"in":0.15,"out":0.60}}
  // цены = USD за 1,000,000 токенов
  const raw = (await getSetting('openai_pricing_json', tenantId) || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function calcCostUSD(model, promptTokens, completionTokens, pricing){
  const m = String(model || '').trim();
  const p = pricing[m] || pricing['*'];
  if (!p || (!p.in && !p.out)) {
    return { in:0, out:0, total:0, known:false };
  }
  const inUsd  = (Number(promptTokens||0) / 1_000_000) * Number(p.in  || 0);
  const outUsd = (Number(completionTokens||0) / 1_000_000) * Number(p.out || 0);
  const total  = inUsd + outUsd;
  return { in: inUsd, out: outUsd, total, known:true };
}

async function seedDefaultsForTenant(tid){
  const def = [
    ['system_prompt','Ты вежливый WhatsApp-ассистент. Отвечай кратко, дружелюбно и по делу.'],
    ['delay_sec','2'],
    ['stopword','стоп'],
    ['startword','включить'],
    ['block_time_min','60'],
    ['followup_enabled','1'],
    ['followup_steps','[]'],
    ['ctx_messages','12'],
    ['summary_every_n','8'],
    ['work_enabled','0'],
    ['work_tz','Asia/Almaty'],
    ['work_rules','[]'],
    ['lang_auto','1'],
    ['slots_enabled','1'],
    ['blacklist_phrases','["не пишите","удалите номер","stop","отпишитесь"]'],
    ['whitelist_phrases','["подробнее","давайте","интересно","хочу","купить"]'],
    ['moderation_enabled','1'],
    ['moderation_badwords','["оскорб","брань","18+","политика"]'],
    ['escalate_after_out_no_reply','3'],
    ['escalation_webhook',''],
    ['telegram_token',''],
    ['telegram_chat',''],
    ['telegram_events','["booked","human_needed","no_reply_after_many_out"]'],
    ['default_model','gpt-4o'],
    ['default_temperature','0.7'],
    ['default_max_tokens','200'],
    ['fu_gate_enabled','1'],
    ['fu_done_phrases','["записал","записала","забронировал","забронировала","оплатил","оплатила","внес предоплату","подтверждаю","подтвердил","оформил","оформлено","готово","приеду","пришла оплата","услуга оказана"]'],
    ['fu_no_follow_phrases','["не интересно","неактуально","не нужно","откажусь","передумал","больше не пишите","удалите номер","стоп","stop"]'],
    ['open_signup','1'],           // публичная регистрация включена
    ['open_signup_role','user'],    // все — user
    ['crm_enabled','1'],                 // вкл/выкл интеграцию
    ['crm_endpoint',''],                 // куда слать "создание лида" (у тебя уже используется)
    ['crm_company_id',''],               // компания
    ['crm_api_key',''],                  // ключ
    ['crm_msg_endpoint',''],             // <-- НОВОЕ: URL приёма СООБЩЕНИЙ
    ['public_base_url',''],

    // ...
    ['tts_enabled','0'],
    ['tts_mode','both'],
    ['tts_model','gpt-4o-mini-tts'],
    ['tts_voice','alloy'],
    ['tts_lang',''],
    ['tts_rate','1.0'],
    ['tts_pitch','0'],

    // ---- Instagram agent defaults (separate keys) ----
    ['ig_system_prompt','Ты вежливый Instagram-ассистент. Отвечай кратко, дружелюбно и по делу.'],
    ['ig_delay_sec','2'],
    ['ig_stopword',''],
    ['ig_startword',''],
    ['ig_block_time_min','0'],

    ['ig_allow_direct','1'],
    ['ig_allow_comments','1'],
    ['ig_allow_comment_dm','0'],
    ['ig_allow_story_mentions','1'],
    ['ig_allow_post_mentions','1'],
    ['ig_stoplist',''],
    ['ig_ctx_messages','18'],

    ['first_message_enabled','0'],
    ['first_message_delay_sec','2'],
    ['first_message_text',''],
    ['first_message_media_file',''],
    ['first_message_media_kind',''],

  ];
  for (const [k,v] of def){
    await run(`INSERT OR REPLACE INTO settings(tenant_id,key,value) VALUES(?,?,?)`,[tid,k,v]);
  }
}

// -------------------------------------------------
// Phrase lists / moderation (per-tenant)
// -------------------------------------------------
async function getPhraseLists(tenantId){
  let bl=[], wl=[], bad=[], fuDone=[], fuNoFollow=[];
  try{ bl=JSON.parse(await getSetting('blacklist_phrases', tenantId)||'[]'); }catch(_){}
  try{ wl=JSON.parse(await getSetting('whitelist_phrases', tenantId)||'[]'); }catch(_){}
  try{ bad=JSON.parse(await getSetting('moderation_badwords', tenantId)||'[]'); }catch(_){}
  try{ fuDone=JSON.parse(await getSetting('fu_done_phrases', tenantId)||'[]'); }catch(_){}
  try{ fuNoFollow=JSON.parse(await getSetting('fu_no_follow_phrases', tenantId)||'[]'); }catch(_){}
  const norm = (arr)=> (arr||[])
  .map(s => String(s || '').trim().toLowerCase())
  .filter(Boolean);
  return { blacklist:norm(bl), whitelist:norm(wl), badwords:norm(bad), fuDone:norm(fuDone), fuNoFollow:norm(fuNoFollow) };
}

// === helper: infer media kind by file path/URL ===
function inferKindFromPath(p = '') {
  const s = String(p).toLowerCase().trim();

  // Отрежем query/hash, возьмем расширение
  const base = s.split('?')[0].split('#')[0];
  const ext = (base.includes('.') ? base.substring(base.lastIndexOf('.') + 1) : '');

  const videoExt = new Set(['mp4','mov','webm','mkv','avi','m4v','3gp','ts']);
  const imageExt = new Set(['jpg','jpeg','png','webp','bmp','gif','svg']);
  const audioExt = new Set(['ogg','opus','m4a','mp3','wav']);
  
  if (audioExt.has(ext)) return 'audio';
  if (videoExt.has(ext)) return 'video';
  if (imageExt.has(ext)) return 'image';

  // Неизвестно
  return '';
}

async function loadMediaTriggers(tenantId) {
  try {
    const raw = await getSetting('media_triggers', tenantId);
    const list = JSON.parse(raw || '[]');
    return (Array.isArray(list) ? list : []).map(x => {
      let kind = (x.media_kind === 'video' ? 'video' : (x.media_kind === 'image' ? 'image' : ''));
      if (!kind) kind = inferKindFromPath(x.media_file) || 'image';
      return {
        label: String(x.label || '').slice(0,120),
        match_type: (x.match_type === 'regex' ? 'regex' : 'contains'),
        pattern: String(x.pattern || '').slice(0,400),
        media_file: String(x.media_file || ''),
        media_kind: kind,
        caption: String(x.caption || ''),
        also_reply_text: String(x.also_reply_text || '')
      };
    });
  } catch {
    return [];
  }
}

function mediaTriggerMatches(trigger, text) {
  const t = String(text || '');
  if (!trigger?.pattern) return false;

  if (trigger.match_type === 'regex') {
    try {
      // Поддержка двух форматов: "/паттерн/gi" или "паттерн"
      const raw = String(trigger.pattern).trim();
      const m = /^\/(.+)\/([gimsuy]*)$/.exec(raw);
      const re = m ? new RegExp(m[1], m[2] || 'i') : new RegExp(raw, 'i');
      return re.test(t);
    } catch {
      return false;
    }
  }

  // contains: альтернативы через "|"
  const alts = String(trigger.pattern).split('|').map(s => s.trim()).filter(Boolean);
  const low = t.toLowerCase();
  return alts.some(p => low.includes(p.toLowerCase()));
}

async function sendMediaByPath(sock, jid, relPath, kind, caption='') {
  // ⚠️ Только личные диалоги: @s.whatsapp.net или @lid (не группы и не broadcast)
  const toJid = normalizeDirectJid(jid);
  if (!toJid || !(toJid.endsWith('@s.whatsapp.net') || toJid.endsWith('@lid'))) {
    throw new Error('bad jid (not a direct chat jid)');
  }

  const rel = String(relPath || '');
  // allow both "uploads/..." (fs-relative) and "/uploads/..." (UI URL path)
  const abs = (path.isAbsolute(rel) && !rel.startsWith('/uploads/'))
    ? rel
    : path.join(__dirname, rel.replace(/^\/+/, ''));
  const buf = await fsp.readFile(abs);

  const resolvedKind = String((kind || inferKindFromPath(relPath)) || '').toLowerCase().trim();

  if (resolvedKind === 'image') {
    await sock.sendMessage(toJid, { image: buf, caption: caption || undefined });
    return;
  }

  if (resolvedKind === 'video') {
    await sock.sendMessage(toJid, { video: buf, caption: caption || undefined });
    return;
  }

  if (resolvedKind === 'video_note') {
    // WhatsApp "видеокружок"
    await sock.sendMessage(toJid, { video: buf, ptv: true });

    // caption не поддерживается у кружка → отправляем отдельным текстом
    if (caption && caption.trim()) {
      await sleep(200);
      await sendLongText(sock, toJid, caption.trim());
    }
    return;
  }

  if (resolvedKind === 'audio') {
    const ext = path.extname(relPath || '').toLowerCase();
    const mimetype =
      ext === '.ogg' ? 'audio/ogg' :
      ext === '.mp3' ? 'audio/mpeg' :
      ext === '.m4a' ? 'audio/mp4' :
      ext === '.wav' ? 'audio/wav' :
      'audio/mpeg';

    await sock.sendMessage(toJid, { audio: buf, mimetype });

    // у audio тоже нет caption → отправляем отдельным текстом
    if (caption && caption.trim()) {
      await sleep(200);
      await sendLongText(sock, toJid, caption.trim());
    }
    return;
  }

  // fallback: документ
  await sock.sendMessage(toJid, { document: buf, fileName: path.basename(relPath) });
  if (caption && caption.trim()) {
    await sleep(200);
    await sendLongText(sock, toJid, caption.trim());
  }
}

// -------------------------------------------------
// Telegram notify (per-tenant)
// -------------------------------------------------
const TG_EVENT_MAP = {
  booked: 'Брондау',
  human_needed: 'Менеджер керек',
  no_reply_after_many_out: 'Бірнеше хаттан соң жауап жоқ',
  blacklist_trigger: 'Стоп-фраза клиента',
  moderation_badword: 'Боқтық сөздер',
  out_moderation_block: 'Заблокировано модерацией (исходящее)',
  payment_received: 'ТӨЛЕМ АЛЫНДЫ/ТҮБІРТЕК'
};
const TG_EVENT_MAP_REV = Object.fromEntries(Object.entries(TG_EVENT_MAP).map(([k,v])=>[v,k]));

async function getTelegramConfig(tenantId){
  const tkn  = (await getSetting('telegram_token', tenantId)||'').trim();
  const chat = (await getSetting('telegram_chat', tenantId)||'').trim();

  let raw = [];
  try { raw = JSON.parse(await getSetting('telegram_events', tenantId)||'[]'); } catch(_){}

  // НОРМАЛИЗАЦИЯ: метки -> коды
  const normCodes = (Array.isArray(raw)?raw:[])
    .map(x => TG_EVENT_MAP_REV[x] || x)                // метка -> код, если было сохранено по-старому
    .filter(k => TG_EVENT_MAP[k]);                     // отбрасываем нерелевантное

  // если что-то поменяли — запишем обратно в БД (одноразовая миграция)
  if (JSON.stringify(normCodes) !== JSON.stringify(raw)) {
    await setSetting('telegram_events', JSON.stringify(normCodes), tenantId);
  }

  const allow = new Set(normCodes.map(String));
  return { tkn, chat, allow };
}

const TG_COOLDOWN = {
  payment_received: 10,
  booked:           300,   // 5 минут
  human_needed:     120,   // 2 минуты
  no_reply_after_many_out: 3600,
  blacklist_trigger:       600,
  moderation_badword:      600,
  out_moderation_block:    600
}

async function notifyTelegram(tenantId, event, payload = {}) {
  const { tkn, chat, allow } = await getTelegramConfig(tenantId);
  if (!tkn || !chat) return;

  if (allow.size && !allow.has(event)) return;

  const COOLDOWN = { booked: 60, human_needed: 60, no_reply_after_many_out: 300, payment_received: 10 };
  const cooldown = COOLDOWN[event] ?? 60;

  // >>> добавьте это:
  const { accId, jid } = payload || {};
  if (!accId || !jid) {
    console.warn('[TG] skip: no accId/jid in payload', { tenantId, event, payload });
    return;
  }
  // <<<

  const ok = await tgShouldSend(tenantId, event, jid, cooldown);
  if (!ok) return;

  let profile = null;
  try { profile = await getProfile(accId, jid); } catch(_) {}

  const name  = profile?.name || '';
  const phoneDigits = jidToPhone(jid);
  const phoneE164 = phoneDigits ? ('+' + phoneDigits) : '';
  const waUrl = phoneDigits ? `https://wa.me/${phoneDigits}` : '';

  const lastIn = await get(
    `SELECT message FROM chats
     WHERE tenant_id=? AND acc_id=? AND jid=? AND type='in'
     ORDER BY ts DESC,id DESC LIMIT 1`,
    [tenantId, accId, jid]
  );
  const lastMsg = (lastIn?.message||'').trim();

  // краткий запрос/интент
  let intent = (profile?.last_intent||'').trim();
  if (!intent) {
    intent = await inferShortIntent(tenantId, accId, jid);
    if (intent) {
      try { await saveProfile(accId, jid, { last_intent: intent }); } catch(_){}
    }
  }

  // текст сообщения (HTML)
  const title = TG_EVENT_MAP[event] || event;
  const msg =
    `<b>${htmlEsc(title)}</b>\n`+
    (name ? `👤 <b>${htmlEsc(name)}</b>\n` : '')+
    `📞 ${htmlEsc(phoneE164 || phoneDigits || '')}\n`+
    (intent ? `📝 Сұранысы: ${htmlEsc(intent)}\n` : '')+
    (lastMsg ? `💬 Соңғы хаты: ${htmlEsc(lastMsg.slice(0,400))}\n` : '');

  // inline-кнопка «WhatsApp»
  const markup = {
    inline_keyboard: [[
      { text: 'WhatsApp АШУ', url: waUrl }
    ]]
  };

  try{
    await fetchWithTimeout(
      `https://api.telegram.org/bot${tkn}/sendMessage`,
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          chat_id: chat,
          text: msg,
          parse_mode: 'HTML',
          reply_markup: markup
        })
      },
      10000 // 10 секунд
    );

      // Если это событие оплаты и в payload есть файл — шлём PDF/документ
      if (event === 'payment_received' && payload?.receipt?.file) {
        try {
          // const base = (await getSetting('public_base_url', tenantId) || '').replace(/\/+$/,'');
          const base = getPublicBaseUrl();
          const rel  = String(payload.receipt.file).replace(/^\/+/, ''); // 'uploads/xxx.pdf'
          const fileUrl = base ? `${base}/${rel}` : null;

          // Подпись к документу
          const amtStr = payload.receipt.currency
            ? `${payload.receipt.amount.toFixed(2)} ${payload.receipt.currency}`
            : payload.receipt.amount.toFixed(2);

          let caption =
            `🧾 Чек/оплата получены\n` +
            (name ? `👤 ${htmlEsc(name)}\n` : '') +
            `📞 ${htmlEsc(phoneE164 || phoneDigits || '')}\n` +
            (intent ? `📝 Запрос: ${htmlEsc(intent)}\n` : '') +
            `💰 Сумма: ${amtStr}`;

        if (fileUrl) {
          // Отправляем как ссылку на документ — Telegram сам скачает
          await fetchWithTimeout(
            `https://api.telegram.org/bot${tkn}/sendDocument`,
            {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({
                chat_id: chat,
                document: fileUrl,
                caption
              })
            },
            10000
          );
        } else {
          // Если public_base_url не задан — пришлём путь текстом
          await fetchWithTimeout(
            `https://api.telegram.org/bot${tkn}/sendMessage`,
            {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({
                chat_id: chat,
                text: caption + (rel ? `\n📎 Файл: ${htmlEsc(rel)}` : ''),
                parse_mode: 'HTML'
              })
            },
            10000
          );
        }
        } catch (e) {
          console.error('TG sendDocument error:', e?.message || e);
        }
      }

  }catch(_){}
}

// -------------------------------------------------
// Uploads (auth required)
// -------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
// uploads
const upload = multer({
  storage,
  // можешь оставить 25 МБ, но лучше сразу чуть больше, чтобы мелкие ZIP тоже проходили
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 МБ
  fileFilter: (_req, file, cb) => {
    const mt  = (file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '');

    const EXCEL_MIMES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel',                                          // .xls
      'text/csv'                                                           // .csv
    ];
    const DOCX_MIMES = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
    ];
    const PPTX_MIMES = [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' // .pptx
    ];

    const TEXT_MIMES = [
      'text/plain',       // .txt
      'text/markdown',    // .md
      'text/x-markdown'   // .md (альтернативный тип)
    ];

    const ok =
      mt.startsWith('image/') ||
      mt.startsWith('video/') ||
      mt.startsWith('audio/') ||              // ← добавили аудио
      mt === 'application/pdf' ||
      EXCEL_MIMES.includes(mt) ||
      DOCX_MIMES.includes(mt) ||
      PPTX_MIMES.includes(mt) ||
      TEXT_MIMES.includes(mt) ||             // ← txt/md по mimetype
      /\.txt$/i.test(name) ||                // ← txt по расширению
      /\.md$/i.test(name) ||                 // ← md по расширению
      mt === 'application/zip' ||
      mt === 'application/x-zip-compressed' ||
      /\.zip$/i.test(name);

    cb(ok ? null : new Error('only image/video/pdf/excel/docx/pptx/zip'), ok);
  }
});

// отдельный загрузчик для аватарок
const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try{
        const dir = path.join(AVATAR_ROOT, String(req.user.tenant_id), String(req.user.id));
        await fsp.mkdir(dir, { recursive:true });
        cb(null, dir);
      }catch(e){
        cb(e);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.png','.jpg','.jpeg','.webp','.gif'].includes(ext) ? ext : '.png';
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + safeExt);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/')) return cb(null, true);
    cb(new Error('image only'));
  }
});
const uploadBrandLogo = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BRAND_ROOT),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ['.png','.jpg','.jpeg','.webp','.gif','.svg'].includes(ext) ? ext : '.png';
      cb(null, 'logo-' + Date.now() + safeExt);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    if (mt.startsWith('image/') || mt === 'image/svg+xml') return cb(null, true);
    cb(new Error('Only images allowed'));
  }
});
app.post('/api/upload', authGuard, upload.single('file'), (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: 'no file' });

    const mime = f.mimetype || '';

    let kind = '';
    if (mime.startsWith('image/')) kind = 'image';
    else if (mime.startsWith('video/')) kind = 'video';
    else if (mime.startsWith('audio/')) kind = 'audio';
    else if (mime === 'application/pdf') kind = 'pdf';
    else if (
      mime === 'application/zip' ||
      mime === 'application/x-zip-compressed' ||
      mime === 'application/octet-stream'
    ) kind = 'zip';
    else kind = 'file';

  res.json({
    ok: true,
    file: 'uploads/' + f.filename,
    url: '/uploads/' + f.filename,
    kind,
    mime: f.mimetype,
    size: f.size,
    name: f.originalname || ''
  });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/upload/delete', authGuard, async (req,res)=>{
  try{
    const rel = String(req.body?.file||'');
    if(!rel.startsWith('uploads/')) return res.status(400).json({ok:false, error:'bad path'});
    await fsp.rm(path.join(__dirname, rel), {force:true});
    res.json({ok:true});
  }catch(e){ res.status(400).json({ok:false, error:e.message}); }
});

app.post('/api/broadcast/import_excel', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  try{
    const rel = String(req.body?.file||''); // 'uploads/xxx.xlsx'
    if (!rel.startsWith('uploads/')) return res.status(400).json({ok:false,error:'bad path'});
    const abs = path.join(__dirname, rel);
    if (!fs.existsSync(abs)) return res.status(404).json({ok:false,error:'file not found'});

    const wb  = XLSX.read(fs.readFileSync(abs), { type:'buffer' });
    const set = new Set();
    wb.SheetNames.forEach(name=>{
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:'' });
      for(const row of rows){
        for(const cell of row){
          const jid = toWaJid(cell);
          if (jid) set.add(jid);
        }
      }
    });
    const list = Array.from(set);
    res.json({ ok:true, count:list.length, jids:list });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/broadcast/select_profiles', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  const { acc_id, q='', stage='' } = req.body||{};
  if (acc_id && !await ensureOwnAccount(req, Number(acc_id)))
    return res.status(403).json({ok:false,error:'forbidden'});

  let sql = `SELECT DISTINCT jid FROM profiles WHERE tenant_id=?`;
  const params = [req.user.tenant_id];
  if (acc_id){ sql += ` AND acc_id=?`; params.push(Number(acc_id)); }
  if (stage){ sql += ` AND stage=?`; params.push(stage); }
  if (q){
    const pat = `%${String(q).toLowerCase()}%`;
    sql += ` AND (LOWER(jid) LIKE ? OR LOWER(name) LIKE ? OR LOWER(city) LIKE ? OR LOWER(interest) LIKE ?)`;
    params.push(pat,pat,pat,pat);
  }
  const rows = await all(sql, params);

  const items = await Promise.all(rows.map(async r => ({
    jid: r.jid,
    phone: await resolvePhoneForAccJid(r.acc_id, r.jid)
  })));

  const jids = items.map(x => x.jid).filter(Boolean);
  res.json({ ok:true, count: items.length, jids, items }); // jids оставили для обратной совместимости
});

app.post('/api/broadcast/create', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  // const { acc_id, title, text, media_file='', media_kind='' , jids=[], settings={} } = req.body||{};

  let { acc_id, title, text, media_file='', media_kind='' , jids=[], settings={} } = req.body||{};
  if (!media_kind && media_file) media_kind = inferKindFromPath(media_file); // 'image' | 'video' | ''

  if (!acc_id || !await ensureOwnAccount(req, Number(acc_id)))
    return res.status(403).json({ok:false,error:'forbidden'});

  // Запрет рассылки при включенном "Дожиме"
  const fuEnabled = (await getSetting('followup_enabled', req.user.tenant_id)) === '1';
  if (fuEnabled) {
    return res.status(409).json({
      ok:false,
      error:'Нельзя запускать рассылку, пока включен Дожим. Выключи Дожим и попробуй снова.'
    });
  }

  const ts = Date.now();
  const ins = await run(`INSERT INTO campaigns
    (tenant_id, acc_id, title, text, media_file, media_kind, created_at, status, settings_json)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    // [req.user.tenant_id, acc_id, (title||'Рассылка'),
    //  (text||''), (media_file||''), (media_kind||''), ts, 'draft', JSON.stringify(settings||{})]);

    [req.user.tenant_id, acc_id, (title||'Рассылка'),
      (text||''), (media_file||''), (media_kind||''), ts, 'draft', JSON.stringify(settings||{})]);
  const cid = ins.lastID;

  // enqueue targets (dedup по UNIQUE)
  for (const raw of Array.isArray(jids)?jids:[]){
    const jid = raw.includes('@') ? raw : toWaJid(raw);
    if (!jid) continue;
    await run(`INSERT OR IGNORE INTO campaign_targets(tenant_id,campaign_id,jid,status) VALUES(?,?,?,'queued')`,
              [req.user.tenant_id, cid, jid]);
  }

  res.json({ ok:true, campaign_id: cid });
});

app.post('/api/broadcast/start', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  const id = Number(req.body?.campaign_id);
  const own = await get(`SELECT * FROM campaigns WHERE id=? AND tenant_id=?`, [id, req.user.tenant_id]);
  if(!own) return res.status(404).json({ok:false,error:'not found'});

  // Запрет рассылки при включенном "Дожиме"
  const fuEnabled = (await getSetting('followup_enabled', req.user.tenant_id)) === '1';
  if (fuEnabled) {
    return res.status(409).json({
      ok:false,
      error:'Нельзя запускать рассылку, пока включен Дожим. Выключи Дожим и попробуй снова.'
    });
  }

  await run(`UPDATE campaigns SET status='running', started_at=COALESCE(started_at,?) WHERE id=?`, [Date.now(), id]);
  res.json({ ok:true });
});
app.post('/api/broadcast/pause', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  const id = Number(req.body?.campaign_id);
  const own = await get(`SELECT * FROM campaigns WHERE id=? AND tenant_id=?`, [id, req.user.tenant_id]);
  if(!own) return res.status(404).json({ok:false,error:'not found'});
  await run(`UPDATE campaigns SET status='paused' WHERE id=?`, [id]);
  res.json({ ok:true });
});
app.get('/api/broadcast/status', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  const id = Number(req.query?.campaign_id);
  const own = await get(`SELECT * FROM campaigns WHERE id=? AND tenant_id=?`, [id, req.user.tenant_id]);
  if(!own) return res.status(404).json({ok:false,error:'not found'});

  const agg = await get(`
    SELECT
      SUM(CASE WHEN status='queued'  THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) skipped,
      SUM(CASE WHEN reply_ts IS NOT NULL THEN 1 ELSE 0 END) replied
    FROM campaign_targets WHERE tenant_id=? AND campaign_id=?`,
    [req.user.tenant_id, id]
  );
  res.json({ ok:true, campaign:own, metrics:agg });
});

app.get('/api/broadcast/list', authGuard, requireFeature(FEATURES.BROADCAST), async (req, res) => {
  try{
    const tid = req.user.tenant_id;
    const status = String(req.query?.status || '').trim();  // опционально: running/done/paused/draft
    const params = [tid];
    let sql = `SELECT * FROM campaigns WHERE tenant_id=?`;
    if (status) { sql += ` AND status=?`; params.push(status); }
    sql += ` ORDER BY id DESC LIMIT 200`;

    const rows = await all(sql, params);
    if (!rows.length) return res.json({ ok:true, items: [] });

    // агрегаты по целям
    const ids = rows.map(r => r.id);
    const marks = ids.map(()=>'?').join(',');

    const agg = await all(
      `SELECT campaign_id,
              SUM(CASE WHEN status='queued'  THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending,
              SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN reply_ts IS NOT NULL THEN 1 ELSE 0 END) AS replied
       FROM campaign_targets
       WHERE tenant_id=? AND campaign_id IN (${marks})
       GROUP BY campaign_id`,
      [tid, ...ids]
    );
    const map = new Map(agg.map(a => [a.campaign_id, a]));

    const items = rows.map(r => ({
      ...r,
      metrics: map.get(r.id) || { queued:0, sending:0, sent:0, failed:0, skipped:0, replied:0 }
    }));

    res.json({ ok:true, items });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/broadcast/logs', authGuard, requireFeature(FEATURES.BROADCAST), async (req,res)=>{
  try{
    const tid = req.user.tenant_id;
    const campaign_id = Number(req.query?.campaign_id);
    if (!campaign_id) return res.status(400).json({ ok:false, error:'campaign_id required' });

    const page  = Math.max(1, parseInt(req.query?.page || '1', 10));
    const limit = Math.min(200, Math.max(10, parseInt(req.query?.limit || '50', 10)));
    const off   = (page-1) * limit;

    // берём только исходящие в рамках кампании
    const rows = await all(
      `SELECT jid, date, ts, message, media_file, media_kind
       FROM chats
       WHERE tenant_id=? AND campaign_id=? AND type='out'
       ORDER BY ts DESC, id DESC
       LIMIT ? OFFSET ?`,
      [tid, campaign_id, limit, off]
    );

    res.json({ ok:true, items: rows, page, limit });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ---------------- SatuCoin API (баланс клиента) ----------------

// Текущий баланс для авторизованного пользователя (по его tenant_id)
app.get('/api/satu/balance', authGuard, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const balance = await getSatuBalance(tenantId);
    // цена за лид: из настроек или дефолт
    const price = await getSatuPricePerLead(tenantId);
    const p = price && price > 0 ? price : SATU_DEFAULT_PRICE_PER_LEAD;

    const approxChats = p > 0 ? Math.floor(balance / p) : 0;

    return res.json({
      ok: true,
      balance,
      price_per_lead: p,
      approx_chats: approxChats
    });
  } catch (e) {
    console.error('GET /api/satu/balance error', e);
    return res.status(500).json({ ok: false, error: 'satu_balance_error' });
  }
});

// ---------------- Analytics helpers ----------------
function getClientIp(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || '';
}

function parseUA(uaRaw){
  const ua = String(uaRaw || '');
  let browser = '';
  let device = '';

  try{
    if (UAParser){
      const p = new UAParser(ua).getResult();
      browser = [p.browser?.name, p.browser?.version].filter(Boolean).join(' ');
      device = p.device?.type || 'desktop';
      if (!device) device = 'desktop';
      return { browser: browser || '', device };
    }
  }catch(_){}

  // fallback (без библиотек)
  const u = ua.toLowerCase();
  device = /mobile|android|iphone|ipad/.test(u) ? 'mobile' : 'desktop';
  if (u.includes('edg/')) browser = 'Edge';
  else if (u.includes('chrome/')) browser = 'Chrome';
  else if (u.includes('safari/') && !u.includes('chrome/')) browser = 'Safari';
  else if (u.includes('firefox/')) browser = 'Firefox';
  else browser = 'Other';
  return { browser, device };
}

function getCountry(req, ip){
  // Cloudflare
  const cf = String(req.headers['cf-ipcountry'] || '').trim();
  if (cf && cf !== 'XX') return cf;

  // geoip-lite (если установлен)
  try{
    if (geoip && ip){
      const g = geoip.lookup(ip);
      if (g && g.country) return g.country;
    }
  }catch(_){}
  return '';
}

function getRefHost(ref){
  try { return ref ? (new URL(ref)).host : ''; } catch { return ''; }
}

function rangeToTs(range){
  const now = new Date();
  const end = Date.now();

  function startOfDay(d){
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  if (range === 'today') {
    return { start: startOfDay(now), end };
  }
  if (range === 'yesterday') {
    const y = new Date(now.getTime() - 24*3600*1000);
    const s = startOfDay(y);
    return { start: s, end: s + 24*3600*1000 };
  }
  if (range === '24h') return { start: end - 24*3600*1000, end };
  if (range === '7d')  return { start: end - 7*24*3600*1000, end };
  if (range === '14d') return { start: end - 14*24*3600*1000, end };
  if (range === '30d') return { start: end - 30*24*3600*1000, end };
  if (range === '90d') return { start: end - 90*24*3600*1000, end };

  if (range === 'last_month') {
    const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const firstPrev = new Date(now.getFullYear(), now.getMonth()-1, 1);
    return { start: firstPrev.getTime(), end: firstThis.getTime() };
  }

  // default
  return { start: end - 7*24*3600*1000, end };
}

// ---------------- Brand logo (global) ----------------

// публично (для index.html)
app.get('/api/brand', async (_req, res) => {
  const logo_url = String((await getSetting('brand_logo_url', 0)) || '').trim();
  res.json({ ok:true, logo_url });
});

// ---------------- Analytics collect (public, safe) ----------------
app.post('/api/analytics/collect', async (req, res) => {
  // никогда не ломаем сайт, даже если БД/парсинг упадет
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const now = Date.now();
    const aid = String(req.cookies?.aid || '').trim() || crypto.randomBytes(12).toString('hex');

    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
    if (!req.cookies?.aid) {
      res.cookie('aid', aid, { httpOnly:true, secure:isSecure, sameSite:'lax', path:'/', maxAge: 90*24*3600*1000 });
    }

    const ip = getClientIp(req);
    const ip_hash = ip ? crypto.createHash('sha256').update(ip + '|' + JWT_SECRET).digest('hex') : '';

    const ua = String(req.headers['user-agent'] || '');
    const { browser, device } = parseUA(ua);
    const country = getCountry(req, ip);

    const type = String(body.type || 'pageview');
    const pathStr = String(body.path || req.headers['referer'] || '').slice(0, 500);
    const ref = String(body.ref || '').slice(0, 1000);
    const ref_host = getRefHost(ref);

    // session cookie sid (30 минут)
    let sid = String(req.cookies?.sid || '').trim();
    let needNew = !sid;

    if (sid) {
      const s = await get(`SELECT sid, last_seen FROM analytics_sessions WHERE sid=?`, [sid]).catch(()=>null);
      if (!s) needNew = true;
      else if ((now - Number(s.last_seen || 0)) > 30*60*1000) needNew = true;
    }

    if (needNew) {
      sid = crypto.randomBytes(12).toString('hex');
      res.cookie('sid', sid, { httpOnly:true, secure:isSecure, sameSite:'lax', path:'/', maxAge: 30*60*1000 });

      await run(
        `INSERT OR REPLACE INTO analytics_sessions
         (sid, aid, first_seen, last_seen, country, ref_host, ref_full, path_first, ua, browser, device, ip_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sid, aid, now, now, country, ref_host, ref, pathStr, ua, browser, device, ip_hash]
      ).catch(()=>{});
    } else {
      await run(
        `UPDATE analytics_sessions SET last_seen=?, country=COALESCE(NULLIF(country,''),?), browser=COALESCE(NULLIF(browser,''),?), device=COALESCE(NULLIF(device,''),?)
         WHERE sid=?`,
        [now, country, browser, device, sid]
      ).catch(()=>{});
    }

    // события пишем только для pageview
    if (type === 'pageview') {
      await run(
        `INSERT INTO analytics_events(ts, sid, aid, type, path, ref_host, country, browser, device)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [now, sid, aid, type, pathStr, ref_host, country, browser, device]
      ).catch(()=>{});
    }

  } catch(_) {}

  return res.json({ ok: true });
});

// админка: текущее
app.get('/api/admin/brand', authGuard, adminOnly, async (_req, res) => {
  const logo_url = String((await getSetting('brand_logo_url', 0)) || '').trim();
  res.json({ ok:true, logo_url });
});

// админка: загрузка файла
app.post('/api/admin/brand/logo', authGuard, adminOnly, uploadBrandLogo.single('logo'), async (req, res) => {
  const rel = req.file ? (`/uploads/brand/${req.file.filename}`) : '';
  await setSetting('brand_logo_url', rel, 0);
  res.json({ ok:true, logo_url: rel });
});

// админка: очистить
app.post('/api/admin/brand/clear', authGuard, adminOnly, async (_req, res) => {
  await setSetting('brand_logo_url', '', 0);
  res.json({ ok:true });
});

// ---------------- Admin analytics summary ----------------
app.get('/api/admin/analytics/summary', authGuard, adminOnly, async (req, res) => {
  try {
    const range = String(req.query?.range || '7d');
    const { start, end } = rangeToTs(range);
    const now = Date.now();

    const pageviewsRow = await get(
      `SELECT COUNT(*) c FROM analytics_events WHERE type='pageview' AND ts>=? AND ts<?`,
      [start, end]
    );

    const uniqueRow = await get(
      `SELECT COUNT(DISTINCT aid) c FROM analytics_events WHERE type='pageview' AND ts>=? AND ts<?`,
      [start, end]
    );

    const regsRow = await get(
      `SELECT COUNT(*) c FROM users WHERE created_at>=? AND created_at<?`,
      [start, end]
    );

    // avg session minutes (по пересечению с диапазоном)
    const avgRow = await get(
      `SELECT
         COUNT(*) AS n,
         SUM( (MIN(last_seen, ?) - MAX(first_seen, ?)) / 60000.0 ) AS minutes_sum
       FROM analytics_sessions
       WHERE last_seen > ? AND first_seen < ?`,
      [end, start, start, end]
    );

    const onlineRow = await get(
      `SELECT COUNT(*) c FROM analytics_sessions WHERE last_seen >= ?`,
      [now - 70*1000]
    );

    const topPages = await all(
      `SELECT path AS k, COUNT(*) AS c
       FROM analytics_events
       WHERE type='pageview' AND ts>=? AND ts<?
       GROUP BY path
       ORDER BY c DESC
       LIMIT 8`,
      [start, end]
    );

    const topRefs = await all(
      `SELECT COALESCE(NULLIF(ref_host,''),'(direct)') AS k, COUNT(*) AS c
       FROM analytics_events
       WHERE type='pageview' AND ts>=? AND ts<?
       GROUP BY k
       ORDER BY c DESC
       LIMIT 8`,
      [start, end]
    );

    const topCountries = await all(
      `SELECT COALESCE(NULLIF(country,''),'--') AS k, COUNT(*) AS c
       FROM analytics_events
       WHERE type='pageview' AND ts>=? AND ts<?
       GROUP BY k
       ORDER BY c DESC
       LIMIT 8`,
      [start, end]
    );

    const topBrowsers = await all(
      `SELECT COALESCE(NULLIF(browser,''),'--') AS k, COUNT(*) AS c
       FROM analytics_events
       WHERE type='pageview' AND ts>=? AND ts<?
       GROUP BY k
       ORDER BY c DESC
       LIMIT 8`,
      [start, end]
    );

    const devSplit = await get(
      `SELECT
        SUM(CASE WHEN device='mobile' THEN 1 ELSE 0 END) AS mobile,
        SUM(CASE WHEN device='desktop' THEN 1 ELSE 0 END) AS desktop
      FROM analytics_events
      WHERE type='pageview' AND ts>=? AND ts<?`,
      [start, end]
    );

    const topDevices = await all(
      `SELECT COALESCE(NULLIF(device,''),'--') AS k, COUNT(*) AS c
       FROM analytics_events
       WHERE type='pageview' AND ts>=? AND ts<?
       GROUP BY k
       ORDER BY c DESC
       LIMIT 8`,
      [start, end]
    );

    const n = Number(avgRow?.n || 0);
    const minutes_sum = Number(avgRow?.minutes_sum || 0);
    const avg_minutes = n > 0 ? (minutes_sum / n) : 0;

    res.json({
      ok: true,
      range,
      start,
      end,
      pageviews: Number(pageviewsRow?.c || 0),
      unique: Number(uniqueRow?.c || 0),
      registrations: Number(regsRow?.c || 0),
      avg_minutes,
      online: Number(onlineRow?.c || 0),
      device_split: {
        mobile: Number(devSplit?.mobile || 0),
        desktop: Number(devSplit?.desktop || 0)
      },
      top: {
        pages: topPages,
        refs: topRefs,
        countries: topCountries,
        browsers: topBrowsers,
        devices: topDevices
      }
    });
  } catch (e) {
    // чтобы админка не падала
    res.json({ ok:true, range: String(req.query?.range||'7d'), pageviews:0, unique:0, registrations:0, avg_minutes:0, online:0, top:{pages:[],refs:[],countries:[],browsers:[],devices:[]} });
  }
});

// ---------------- Админ-API: Пользователи (панель) ----------------

// ---------------- Админ-API: Уведомления пользователям ----------------
app.post('/api/admin/notify', authGuard, adminOnly, async (req,res)=>{
  try{
    const text = String(req.body?.text || '').trim();
    if(!text) return res.status(400).json({ ok:false, error:'text required' });

    let image_file = String(req.body?.image_file || req.body?.image_url || '').trim();
    // допускаем полный URL или "/uploads/..." — нормализуем к "uploads/..."
    if(/^https?:\/\//i.test(image_file)){
      try{ image_file = (new URL(image_file)).pathname; }catch(_){}
    }
    image_file = String(image_file || '').replace(/^\/+/, '').trim();

    const send_all = !!req.body?.send_all;
    const user_ids = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map(v=>Number(v)).filter(n=>Number.isFinite(n) && n>0)
      : [];

    if(!send_all && user_ids.length===0){
      return res.status(400).json({ ok:false, error:'choose recipients or send_all' });
    }

    const created_at = Date.now();
    await run(
      `INSERT INTO admin_notifications(text, image_file, target_all, created_by, created_at)
       VALUES(?,?,?,?,?)`,
      [text, image_file || null, send_all ? 1 : 0, req.user.id, created_at]
    );

    const row = await get(`SELECT last_insert_rowid() AS id`);
    const notifId = Number(row?.id || 0);

    if(!send_all && notifId){
      for(const uid of user_ids){
        await run(
          `INSERT OR IGNORE INTO admin_notification_targets(notif_id, user_id) VALUES(?,?)`,
          [notifId, uid]
        );
      }
    }

    res.json({ ok:true, id: notifId });
  }catch(e){
    console.error('POST /api/admin/notify error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/api/admin/notify/list', authGuard, adminOnly, async (_req,res)=>{
  try{
    const rows = await all(`
      SELECT
        n.id,
        n.text,
        n.image_file,
        n.target_all,
        n.is_active,
        n.created_at,
        u.email AS created_by_email,
        (SELECT COUNT(*) FROM admin_notification_targets t WHERE t.notif_id = n.id) AS targets_count,
        (SELECT COUNT(*) FROM admin_notification_views v WHERE v.notif_id = n.id) AS views_count
      FROM admin_notifications n
      LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.id DESC
      LIMIT 50
    `);
    res.json({ ok:true, items: rows });
  }catch(e){
    console.error('GET /api/admin/notify/list error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/api/admin/notify/history', authGuard, adminOnly, async (_req,res)=>{
  try{
    const rows = await all(`
      SELECT
        n.id,
        n.text,
        n.image_file,
        n.target_all,
        n.created_at,
        (SELECT COUNT(1) FROM admin_notification_views v WHERE v.notif_id = n.id) AS views_count,
        (SELECT COUNT(1) FROM admin_notification_targets t WHERE t.notif_id = n.id) AS targets_count,
        n.created_by
      FROM admin_notifications n
      ORDER BY n.id DESC
      LIMIT 50
    `);
    res.json({ ok:true, items: rows });
  }catch(e){
    console.error('GET /api/admin/notify/history error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/api/admin/notify/views', authGuard, adminOnly, async (req,res)=>{
  try{
    const notif_id = Number(req.query?.notif_id || req.query?.notify_id || 0);
    if(!notif_id) return res.status(400).json({ ok:false, error:'notif_id required' });

    const totalRow = await get(`SELECT COUNT(*) c FROM admin_notification_views WHERE notif_id=?`, [notif_id]);
    const total = Number(totalRow?.c || 0);

    const items = await all(`
      SELECT
        v.user_id,
        v.seen_at,
        u.email,
        u.tenant_id,
        u.role
      FROM admin_notification_views v
      LEFT JOIN users u ON u.id = v.user_id
      WHERE v.notif_id = ?
      ORDER BY v.seen_at DESC
      LIMIT 2000
    `,[notif_id]);

    res.json({ ok:true, total, items });
  }catch(e){
    console.error('GET /api/admin/notify/views error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

function clampInt(v, minV, maxV, defV){
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return defV;
  return Math.max(minV, Math.min(maxV, n));
}

async function tenantFilesForStorage(tenantId){
  // собираем только "явные" загруженные файлы (без всех чатов, иначе будет очень тяжело)
  const rows = await all(`
    SELECT filename AS f FROM kb_files WHERE tenant_id=?
    UNION
    SELECT media_file AS f FROM msg_templates WHERE tenant_id=? AND media_file IS NOT NULL AND media_file <> ''
    UNION
    SELECT media_file AS f FROM campaigns WHERE tenant_id=? AND media_file IS NOT NULL AND media_file <> ''
    UNION
    SELECT file      AS f FROM receipts WHERE tenant_id=? AND file IS NOT NULL AND file <> ''
    UNION
    SELECT media_file AS f FROM firstmsg_jobs WHERE tenant_id=? AND media_file IS NOT NULL AND media_file <> ''
  `,[tenantId,tenantId,tenantId,tenantId]);
  

  const uniq = new Set();
  for(const r of rows){ if(r?.f) uniq.add(String(r.f)); }
  return [...uniq];
}

async function calcTenantStorage(tenantId){
  const files = await tenantFilesForStorage(tenantId);
  let total = 0;
  const items = [];
  for(const rel of files.slice(0, 3000)){
    const s = String(rel||'').trim();
    if(!s.startsWith('uploads/')) continue;
    const abs = path.join(__dirname, s);
    try{
      const st = await fsp.stat(abs);
      if(st.isFile()){
        total += st.size;
        items.push({ file:s, size:st.size, url:`/${s}` });
      }
    }catch(_){}
  }
  items.sort((a,b)=> (b.size||0) - (a.size||0));
  return { total_bytes: total, top_files: items.slice(0, 50), total_files: items.length };
}

function rangeToWindow(range){
  const r = String(range || '7d').toLowerCase();
  const now = new Date();
  const nowSec = Math.floor(Date.now()/1000);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTodaySec = Math.floor(startOfToday.getTime()/1000);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfMonthSec = Math.floor(startOfMonth.getTime()/1000);

  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const startOfPrevMonthSec = Math.floor(startOfPrevMonth.getTime()/1000);

  if(r === 'today') return { from: startOfTodaySec, to: nowSec, label:'today' };
  if(r === 'yesterday'){
    const from = startOfTodaySec - 86400;
    const to = startOfTodaySec;
    return { from, to, label:'yesterday' };
  }
  if(r === '24h') return { from: nowSec - 86400, to: nowSec, label:'24h' };
  if(r === '7d')  return { from: nowSec - 86400*7, to: nowSec, label:'7d' };
  if(r === '14d') return { from: nowSec - 86400*14, to: nowSec, label:'14d' };
  if(r === '90d') return { from: nowSec - 86400*90, to: nowSec, label:'90d' };
  if(r === 'month') return { from: startOfMonthSec, to: nowSec, label:'month' };
  if(r === 'prev_month') return { from: startOfPrevMonthSec, to: startOfMonthSec, label:'prev_month' };
  if(r === '1m') return { from: nowSec - 60, to: nowSec, label:'1m' };

  // default = 30d
  return { from: nowSec - 86400*30, to: nowSec, label:'30d' };
}

// Список пользователей (по 20 в "папке"), поиск по email / tenant_id
app.get('/api/admin/users', authGuard, adminOnly, async (req,res)=>{
  try{
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = clampInt(req.query.page, 1, 1000000, 1);
    const per  = (String(req.query.per||'20').toLowerCase() === 'all')
      ? 1000000
      : clampInt(req.query.per, 1, 200, 20);
    const off  = (page - 1) * per;

    const where = [];
    const params = [];

    // (можно показывать и админов тоже, но обычно их мало — оставим)
    if(q){
      where.push(`(lower(u.email) LIKE ? OR CAST(u.tenant_id AS TEXT) LIKE ?)`);
      params.push(`%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await get(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, params);
    const total = Number(totalRow?.c || 0);

    const rows = await all(
      `SELECT u.id AS user_id,
              u.tenant_id,
              u.email,
              u.role,
              CASE
                WHEN u.google_sub IS NOT NULL AND u.google_sub <> '' THEN 'google'
                WHEN u.apple_sub  IS NOT NULL AND u.apple_sub  <> '' THEN 'apple'
                ELSE 'password'
              END AS auth_provider,
              u.created_at,
              u.email_verified,
              u.disabled,
              IFNULL(w.balance,0) AS balance,
              (
                SELECT s.value FROM settings s
                WHERE s.tenant_id = u.tenant_id AND s.key='satu_price_per_lead'
                LIMIT 1
              ) AS tariff,
              (
                SELECT s.value FROM settings s
                WHERE s.tenant_id = u.tenant_id AND s.key='tariff_plan'
                LIMIT 1
              ) AS plan
       FROM users u
       LEFT JOIN satu_wallets w ON w.tenant_id = u.tenant_id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, per, off]
    );

    res.json({ ok:true, items: rows, total, page, per });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Детальная карточка пользователя
app.get('/api/admin/users/details', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.query.user_id || 0);
    const range = String(req.query.range || '7d');
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });

    const u = await get(
      `SELECT u.id AS user_id, u.tenant_id, u.email, u.role, u.created_at, u.email_verified, u.disabled,
              IFNULL(w.balance,0) AS balance
       FROM users u
       LEFT JOIN satu_wallets w ON w.tenant_id = u.tenant_id
       WHERE u.id=?`,
      [userId]
    );
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    const tenantId = Number(u.tenant_id);

    const w = rangeToWindow(range);

    const aiTotals = await get(
      `SELECT
        COUNT(*) AS msgs,
        SUM(prompt_tokens) AS pt,
        SUM(completion_tokens) AS ct,
        SUM(total_tokens) AS tt,
        SUM(cost_usd) AS cost
      FROM chats
      WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?`,
      [tenantId, w.from, w.to]
    );

    const aiByChat = await all(
      `SELECT acc_id, jid,
              COUNT(*) AS msgs,
              SUM(total_tokens) AS tt,
              SUM(cost_usd) AS cost
      FROM chats
      WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?
      GROUP BY acc_id, jid
      ORDER BY cost DESC
      LIMIT 50`,
      [tenantId, w.from, w.to]
    );

    const tariff = await getSetting('satu_price_per_lead', tenantId);
    const plan   = await getSetting('tariff_plan', tenantId);

    const counts = {
      accounts:   Number((await get(`SELECT COUNT(*) c FROM accounts WHERE tenant_id=?`, [tenantId]))?.c || 0),
      chats:      Number((await get(`SELECT COUNT(*) c FROM chats WHERE tenant_id=?`, [tenantId]))?.c || 0),
      leads:      Number((await get(`SELECT COUNT(*) c FROM profiles WHERE tenant_id=?`, [tenantId]))?.c || 0),
      templates:  Number((await get(`SELECT COUNT(*) c FROM msg_templates WHERE tenant_id=?`, [tenantId]))?.c || 0),
      kb_files:   Number((await get(`SELECT COUNT(*) c FROM kb_files WHERE tenant_id=?`, [tenantId]))?.c || 0),
      receipts:   Number((await get(`SELECT COUNT(*) c FROM receipts WHERE tenant_id=?`, [tenantId]))?.c || 0),
      campaigns:  Number((await get(`SELECT COUNT(*) c FROM campaigns WHERE tenant_id=?`, [tenantId]))?.c || 0)
    };

    const settingsKeys = [
      'first_message_enabled','first_message_delay_sec','first_message_text','first_message_media_kind','first_message_media_file',
      'followup_enabled','followup_steps',

      // --- IG settings (чтобы панель после F5 видела сохранённое) ---
      'ig_ctx_messages',
      'ig_system_prompt',
      'ig_delay_sec',
      'ig_block_time_min',
      'ig_stopword',
      'ig_startword',
      'ig_stoplist',

      'ig_allow_direct',
      'ig_allow_comments',
      'ig_allow_comment_dm',
      'ig_allow_story_mentions',
      'ig_allow_post_mentions',

      // (на будущее/для media policy)
      'ig_dm_media_action',
      'ig_media_fallback_text',

    ];
    const settings = {};
    for(const k of settingsKeys){
      const v = await getSetting(k, tenantId);
      if(v !== null && v !== undefined) settings[k]=v;
    }

    const kb = await all(`SELECT id, title, filename, file_kind, uploaded_at FROM kb_files WHERE tenant_id=? ORDER BY uploaded_at DESC LIMIT 50`, [tenantId]);
    const tpl = await all(`SELECT id, title, media_kind, media_file, created_at, updated_at FROM msg_templates WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 50`, [tenantId]);

    // storage
    const storage = await calcTenantStorage(tenantId);

    const entitlements = await getTenantEntitlements(tenantId);
    res.json({
      ok:true,
      user: { ...u, tariff: tariff || '', plan: plan || '' },
      counts,
      settings,
      entitlements,
      kb_files: kb,
      templates: tpl,
      ai_usage: {
      range: w.label,
      window: w,
      totals: {
        msgs: Number(aiTotals?.msgs||0),
        prompt_tokens: Number(aiTotals?.pt||0),
        completion_tokens: Number(aiTotals?.ct||0),
        total_tokens: Number(aiTotals?.tt||0),
        cost_usd: Number(aiTotals?.cost||0)
      },
      by_chat: aiByChat
    },
      storage
    });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/admin/tariff_plans', authGuard, adminOnly, async (req,res)=>{
  const items = await all(`SELECT id,name,price_kzt,wa_max,tg_max,feature_mask,created_at
                          FROM tariff_plans ORDER BY id DESC`);
  res.json({ ok:true, items });
});

app.post('/api/admin/tariff_plans/save', authGuard, adminOnly, async (req,res)=>{
  const b = req.body || {};
  const id = Number(b.id || 0);
  const name = String(b.name||'').trim();
  const price_kzt = Number(b.price_kzt||0);
  const wa_max = Number(b.wa_max||10);
  const tg_max = Number(b.tg_max||999);
  const feature_mask = Number(b.feature_mask||0);

  if(!name) return res.status(400).json({ ok:false, error:'NAME_REQUIRED' });

  if(id > 0){
    await run(`UPDATE tariff_plans SET name=?, price_kzt=?, wa_max=?, tg_max=?, feature_mask=? WHERE id=?`,
      [name, price_kzt, wa_max, tg_max, feature_mask, id]
    );
    return res.json({ ok:true, id });
  }else{
    const r = await run(`INSERT INTO tariff_plans(name,price_kzt,wa_max,tg_max,feature_mask) VALUES(?,?,?,?,?)`,
      [name, price_kzt, wa_max, tg_max, feature_mask]
    );
    res.json({ ok:true, id: r.lastID });
  }
});

app.post('/api/admin/tariff_plans/delete', authGuard, adminOnly, async (req,res)=>{
  const id = Number(req.body?.id || 0);
  if(!id) return res.status(400).json({ ok:false, error:'ID_REQUIRED' });
  await run(`DELETE FROM tariff_plans WHERE id=?`, [id]);
  res.json({ ok:true });
});

app.get('/api/admin/ai/summary', authGuard, adminOnly, async (req,res)=>{
  try{
    const { from, to, label } = rangeToWindow(req.query.range);

    const totals = await get(
      `SELECT
         COUNT(*) AS msgs,
         SUM(prompt_tokens) AS pt,
         SUM(completion_tokens) AS ct,
         SUM(total_tokens) AS tt,
         SUM(cost_usd) AS cost,
         SUM(cost_usd_in) AS cost_in,
         SUM(cost_usd_out) AS cost_out,
         SUM(cost_usd_total) AS cost_total
       FROM chats
       WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?`,
      [from, to]
    );

    const by_model = await all(
      `SELECT model,
              COUNT(*) AS msgs,
              SUM(total_tokens) AS tt,
              SUM(cost_usd) AS cost
       FROM chats
       WHERE type='out' AND total_tokens>0 AND ts>=? AND ts<?
       GROUP BY model
       ORDER BY cost DESC`,
      [from, to]
    );

    res.json({
      ok:true,
      range: label,
      window: { from, to },
      totals: {
        msgs: Number(totals?.msgs||0),
        prompt_tokens: Number(totals?.pt||0),
        completion_tokens: Number(totals?.ct||0),
        total_tokens: Number(totals?.tt||0),
        cost_usd: Number(totals?.cost||0),
        cost_usd_in: Number(totals?.cost_in || 0),
        cost_usd_out: Number(totals?.cost_out || 0),
        cost_usd_total: Number(totals?.cost_total || 0)
      },
      by_model
    });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/admin/users/ai_messages', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.query.user_id || 0);
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });

    const u = await get(`SELECT tenant_id FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    const tenantId = Number(u.tenant_id);
    const { from, to } = rangeToWindow(req.query.range);

    const q = String(req.query.q || '').trim();
    const limit = Math.min(300, Math.max(20, parseInt(req.query.limit || '120',10)));

    const params = [tenantId, from, to];
    let sql = `
      SELECT id, ts, acc_id, jid, message, model, total_tokens, cost_usd
      FROM chats
      WHERE tenant_id=? AND type='out' AND total_tokens>0 AND ts>=? AND ts<?
    `;

    if(q){
      sql += ` AND message LIKE ?`;
      params.push(`%${q}%`);
    }

    sql += ` ORDER BY ts DESC, id DESC LIMIT ?`;
    params.push(limit);

    const rows = await all(sql, params);
    res.json({ ok:true, items: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Пополнение/списание SatuCoin по user_id
app.post('/api/admin/users/topup', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.body?.user_id || 0);
    const amount = Number(req.body?.amount || 0);
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });
    if(!Number.isFinite(amount) || amount === 0) return res.status(400).json({ ok:false, error:'amount_required' });

    const u = await get(`SELECT tenant_id FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    const balance = await changeSatuBalance(Number(u.tenant_id), amount, {
      userId: req.user.id,
      reason: 'admin_topup',
      meta: { user_id: userId }
    });

    // ✅ popup уведомление пользователю (таргетированно)
    try{
      const abs = Math.abs(amount);
      const txt = amount > 0
        ? `Вам начислено ${abs} SatuCoin.`
        : `С вашего баланса списано ${abs} SatuCoin.`;

      const ins = await run(
        `INSERT INTO admin_notifications(text,image_file,target_all,is_active,created_at,created_by)
         VALUES(?,?,?,?,?,?)`,
        [txt, '', 0, 1, Date.now(), req.user.id]
      );
      const notifId = ins.lastID;
      await run(
        `INSERT OR IGNORE INTO admin_notification_targets(notif_id,user_id) VALUES(?,?)`,
        [notifId, userId]
      );
      // если пользователь онлайн — сразу «пингуем», чтобы popup появился без ожидания поллинга
      try{ io.to(`user_${userId}`).emit('notify:admin', { id: notifId }); }catch(_){ }
    }catch(_){ /* ignore notify errors */ }

    res.json({ ok:true, balance });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message, code:e.code||'' });
  }
});

// -------------------------------------------------
// Admin: настройка «подарка» SatuCoin новым пользователям (глобально)
// хранится в settings tenant_id=0, key='satu_signup_bonus'
// -------------------------------------------------
app.get('/api/admin/satu/signup_bonus', authGuard, adminOnly, async (_req,res)=>{
  try{
    const v = Number(await getSetting('satu_signup_bonus', 0) || 0);
    res.json({ ok:true, bonus: Number.isFinite(v) ? v : 0 });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/admin/satu/signup_bonus', authGuard, adminOnly, async (req,res)=>{
  try{
    let b = Number(req.body?.bonus ?? 0);
    if(!Number.isFinite(b) || b < 0) return res.status(400).json({ ok:false, error:'bonus must be >= 0' });
    b = Math.floor(b);
    await setSetting('satu_signup_bonus', String(b), 0);
    res.json({ ok:true, bonus: b });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Изменить тариф (цена за лид)
app.post('/api/admin/users/tariff', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.body?.user_id || 0);
    const price  = Number(req.body?.price || 0);
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });
    if(!Number.isFinite(price) || price <= 0) return res.status(400).json({ ok:false, error:'price_required' });

    const u = await get(`SELECT tenant_id FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    await setSetting('satu_price_per_lead', String(price), Number(u.tenant_id));
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Изменить тариф-план (строка)
app.post('/api/admin/users/plan', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.body?.user_id || 0);
    const plan   = String(req.body?.plan || '').trim();
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });

    const u = await get(`SELECT tenant_id FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    await setSetting('tariff_plan', plan, Number(u.tenant_id));
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/admin/users/entitlements', authGuard, adminOnly, async (req,res)=>{
  const userId = Number(req.body?.user_id || 0);
  if(!userId) return res.status(400).json({ ok:false, error:'USER_ID_REQUIRED' });

  const u = await get('SELECT id as user_id, tenant_id FROM users WHERE id=?', [userId]);
  if(!u) return res.status(404).json({ ok:false, error:'USER_NOT_FOUND' });

  const tenantId = Number(u.tenant_id);

  const feature_mask = Number(req.body?.feature_mask);
  const wa_max = Number(req.body?.wa_max);
  const tg_max = Number(req.body?.tg_max);

  const body = req.body || {};
  const hasPlanId = Object.prototype.hasOwnProperty.call(body, 'plan_id');

  const plan_id_raw = body.plan_id;
  const plan_id =
    (plan_id_raw === null || plan_id_raw === undefined || plan_id_raw === '')
      ? 0
      : Number(plan_id_raw);

  if (hasPlanId) {
    // 0 или пусто = очистить тариф
    await setSetting('ent_plan_id', String(plan_id || ''), tenantId);
  }
  if(Number.isFinite(feature_mask)){
    await setSetting('ent_feature_mask', String(feature_mask), tenantId);
  }
  if(Number.isFinite(wa_max)){
    await setSetting('ent_wa_max', String(wa_max), tenantId);
  }
  if(Number.isFinite(tg_max)){
    await setSetting('ent_tg_max', String(tg_max), tenantId);
  }

  res.json({ ok:true });
});

// Отключить/включить аккаунт (и принудительно выключить AI)
app.post('/api/admin/users/toggle_disable', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.body?.user_id || 0);
    const disabled = Number(req.body?.disabled || 0) ? 1 : 0;
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });

    const u = await get(`SELECT id, tenant_id, disabled FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    const tenantId = Number(u.tenant_id);

    await run(`UPDATE users SET disabled=? WHERE id=?`, [disabled, userId]);

    if(disabled){
      // сохраняем предыдущие ai_enabled и выключаем
      await run(`UPDATE accounts SET ai_enabled_prev = ai_enabled, ai_enabled = 0 WHERE tenant_id=?`, [tenantId]);

      // выключаем фичи-авторассылок/автопервого сообщения
      const fuPrev = await getSetting('followup_enabled', tenantId);
      const fmPrev = await getSetting('first_message_enabled', tenantId);
      await setSetting('disabled_prev_followup_enabled', String(fuPrev ?? ''), tenantId);
      await setSetting('disabled_prev_first_message_enabled', String(fmPrev ?? ''), tenantId);

      await setSetting('followup_enabled', '0', tenantId);
      await setSetting('first_message_enabled', '0', tenantId);

      // пауза активных кампаний
      await run(`UPDATE campaigns SET status='paused', processing=0 WHERE tenant_id=? AND status='running'`, [tenantId]);
    }else{
      // восстановление ai_enabled
      await run(`UPDATE accounts SET ai_enabled = COALESCE(ai_enabled_prev, 1), ai_enabled_prev = NULL WHERE tenant_id=?`, [tenantId]);

      // восстановление настроек
      const fuPrev = await getSetting('disabled_prev_followup_enabled', tenantId);
      const fmPrev = await getSetting('disabled_prev_first_message_enabled', tenantId);

      if(fuPrev !== null && fuPrev !== undefined && String(fuPrev) !== ''){
        await setSetting('followup_enabled', String(fuPrev), tenantId);
      }
      if(fmPrev !== null && fmPrev !== undefined && String(fmPrev) !== ''){
        await setSetting('first_message_enabled', String(fmPrev), tenantId);
      }

      await setSetting('disabled_prev_followup_enabled', '', tenantId);
      await setSetting('disabled_prev_first_message_enabled', '', tenantId);
    }

    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Войти как пользователь (impersonation)
// 1) сохраняем текущий админский token в cookie admin_token
// 2) ставим token пользователя
app.post('/api/admin/users/impersonate', authGuard, adminOnly, async (req,res)=>{
  try{
    const userId = Number(req.body?.user_id || 0);
    if(!userId) return res.status(400).json({ ok:false, error:'user_id_required' });

    const u = await get(`SELECT id, tenant_id, email, role FROM users WHERE id=?`, [userId]);
    if(!u) return res.status(404).json({ ok:false, error:'not_found' });

    const token = jwt.sign({ uid:u.id, tid:u.tenant_id, role:u.role, email:u.email }, JWT_SECRET, { expiresIn:'30d' });

    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');

    // сохраняем админский токен (если ещё не в режиме impersonate)
    const currentTok = req.cookies?.token || '';
    if(!req.cookies?.admin_token){
      res.cookie('admin_token', currentTok, {
        httpOnly:true,
        secure:isSecure,
        sameSite:'lax',
        path:'/',
        maxAge: 30 * 24 * 3600 * 1000
      });
    }

    res.cookie('token', token, {
      httpOnly:true,
      secure:isSecure,
      sameSite:'lax',
      path:'/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Вернуться из режима "войти как" обратно в админку
app.post('/api/admin/impersonate/stop', async (req,res)=>{
  try{
    const adminTok = req.cookies?.admin_token || '';
    if(!adminTok) return res.status(400).json({ ok:false, error:'no_admin_token' });

    let p;
    try{ p = jwt.verify(adminTok, JWT_SECRET); }catch(_){ p = null; }
    if(!p || p.role !== 'admin'){
      res.clearCookie('admin_token', { path:'/' });
      return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');

    res.cookie('token', adminTok, {
      httpOnly:true,
      secure:isSecure,
      sameSite:'lax',
      path:'/',
      maxAge: 30 * 24 * 3600 * 1000
    });
    res.clearCookie('admin_token', { path:'/' });

    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ---------------- Админ-API по SatuCoin ----------------

// Список всех tenants с балансом + тариф (только для role === 'admin')
app.get('/api/admin/satu/list', authGuard, async (req,res)=>{
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const rows = await all(
      `SELECT t.id AS tenant_id,
              COALESCE(u.email, t.name) AS tenant_label,
              IFNULL(w.balance,0) AS balance,
              t.created_at,
              (
                SELECT s.value
                FROM settings s
                WHERE s.tenant_id = t.id
                  AND s.key = 'satu_price_per_lead'
              ) AS satu_cost_per_chat
       FROM tenants t
       LEFT JOIN satu_wallets w ON w.tenant_id = t.id
       LEFT JOIN (
         SELECT tenant_id, MIN(email) AS email
         FROM users
         GROUP BY tenant_id
       ) u ON u.tenant_id = t.id
       ORDER BY t.id`
    );

    res.json({ ok:true, items: rows });
  } catch (e) {
    console.error('[SATU][admin_list] error:', e);
    return res.status(500).json({ ok:false, error:'satu_admin_list_failed' });
  }
});

// История операций по tenant
app.get('/api/admin/satu/history', authGuard, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const tenantId = Number(req.query.tenant_id || 0);
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id_required' });
    }

    const items = await all(
      `SELECT st.id,
              st.amount,
              st.reason,
              st.meta,
              st.created_at,
              u.email as created_by_email
       FROM satu_transactions st
       LEFT JOIN users u ON u.id = st.user_id
       WHERE st.tenant_id = ?
       ORDER BY st.id DESC
       LIMIT 100`,
      [tenantId]
    );

    return res.json({ ok: true, items });
  } catch (e) {
    console.error('[SATU][admin_history] error:', e);
    return res.status(500).json({ ok: false, error: 'satu_admin_history_failed' });
  }
});

const OPENAI_ADMIN_KEY = (process.env.OPENAI_ADMIN_KEY || '').trim();

async function openaiOrgGET(path, query){
  if (!OPENAI_ADMIN_KEY) throw new Error('OPENAI_ADMIN_KEY_MISSING');
  const qs = new URLSearchParams();
  Object.entries(query||{}).forEach(([k,v])=>{
    if (v===undefined || v===null || v==='') return;
    qs.set(k, String(v));
  });
  const url = `https://api.openai.com${path}?${qs.toString()}`;
  const resp = await fetchWithTimeout(url, {
    method:'GET',
    headers: { 'Authorization': `Bearer ${OPENAI_ADMIN_KEY}` }
  }, 15000);
  const txt = await resp.text().catch(()=> '');
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!resp.ok) throw new Error(data?.error?.message || `HTTP_${resp.status}`);
  return data;
}

function rangeToStartEnd(rangeKey){
  const now = new Date();
  const end = Math.floor(Date.now()/1000);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTodayTs = Math.floor(startOfToday.getTime()/1000);

  const startOfYesterdayTs = startOfTodayTs - 86400;

  function startOfMonth(y,m){ return Math.floor(new Date(y,m,1).getTime()/1000); }

  if (rangeKey==='today') return { start:startOfTodayTs, end };
  if (rangeKey==='yesterday') return { start:startOfYesterdayTs, end:startOfTodayTs };
  if (rangeKey==='24h') return { start:end-86400, end };
  if (rangeKey==='7d') return { start:end-7*86400, end };
  if (rangeKey==='14d') return { start:end-14*86400, end };
  if (rangeKey==='30d' || rangeKey==='month') return { start:end-30*86400, end };
  if (rangeKey==='90d') return { start:end-90*86400, end };

  if (rangeKey==='prev_month'){
    const y = now.getFullYear(), m = now.getMonth();
    const startPrev = startOfMonth(y, m-1);
    const startThis = startOfMonth(y, m);
    return { start:startPrev, end:startThis };
  }

  return { start:end-7*86400, end };
}

app.get('/api/admin/openai/costs', authGuard, adminOnly, async (req,res)=>{
  try{
    const range = String(req.query.range || '7d');
    const { start, end } = rangeToStartEnd(range);

    // bucket_width можно 1d, чтобы красиво строить таблицу
    const data = await openaiOrgGET('/v1/organization/costs', {
      start_time: start,
      end_time: end,
      bucket_width: '1d'
    });

    res.json({ ok:true, range, start, end, data });
  }catch(e){
    res.status(400).json({ ok:false, error: e?.message || String(e) });
  }
});

// Установка тарифа SatuCoin за 1 чат / лид для конкретного tenant
app.post('/api/admin/satu/tariff', authGuard, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const tenantId    = Number(req.body.tenant_id || 0);
    const costPerChat = Number(req.body.cost_per_chat || 0);

    if (!tenantId || !Number.isFinite(costPerChat) || costPerChat <= 0) {
      return res.status(400).json({ ok:false, error:'bad_tenant_or_cost' });
    }

    // Храним тариф в таблице settings по ключу 'satu_price_per_lead'
    await run(
      `INSERT INTO settings(tenant_id, key, value)
       VALUES(?, 'satu_price_per_lead', ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      [tenantId, String(costPerChat)]
    );

    return res.json({ ok:true });
  } catch (e) {
    console.error('[SATU][admin_tariff] error:', e);
    return res.status(500).json({ ok:false, error:'satu_admin_tariff_failed' });
  }
});

// Пополнение / списание SatuCoin админом
app.post('/api/admin/satu/topup', authGuard, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const tenantId = Number(req.body.tenant_id || 0);
    const amount   = Number(req.body.amount || 0); // может быть и отрицательным (коррекция)
    const reason   = String(req.body.reason || 'admin_topup');

    if (!tenantId || !amount) {
      return res.status(400).json({ ok: false, error: 'tenant_id_and_amount_required' });
    }

    const newBal = await changeSatuBalance(tenantId, amount, {
      userId: req.user.id,
      reason,
      meta: { from: 'admin_panel' }
    });

    // ✅ Popup уведомление всем пользователям этого tenant'а (если начисление/списание делали по tenant_id)
    try{
      const abs = Math.abs(amount);
      const txt = amount > 0
        ? `Вам начислено ${abs} SatuCoin.`
        : `С вашего баланса списано ${abs} SatuCoin.`;

      const ins = await run(
        `INSERT INTO admin_notifications(text,image_file,target_all,is_active,created_at,created_by)
         VALUES(?,?,?,?,?,?)`,
        [txt, '', 0, 1, Date.now(), req.user.id]
      );
      const notifId = ins.lastID;
      const users = await all(`SELECT id FROM users WHERE tenant_id=?`, [tenantId]);
      for(const u of (users||[])){
        if(!u?.id) continue;
        await run(`INSERT OR IGNORE INTO admin_notification_targets(notif_id,user_id) VALUES(?,?)`, [notifId, u.id]);
        try{ io.to(`user_${u.id}`).emit('notify:admin', { id: notifId }); }catch(_){ }
      }
    }catch(_){ }

    return res.json({ ok: true, balance: newBal });
  } catch (e) {
    console.error('[SATU][admin_topup] error:', e);
    if (e.code === 'SATU_NO_FUNDS') {
      return res.status(400).json({ ok: false, error: 'not_enough_balance_for_delta' });
    }
    return res.status(500).json({ ok: false, error: 'satu_admin_topup_failed' });
  }
});

function flattenChatGptExport(exportJson){
  const arr = Array.isArray(exportJson) ? exportJson : [];
  const out = [];

  for (const conv of arr){
    if (!conv) continue;

    const title   = String(conv.title || 'Без названия').trim();
    const created = conv.create_time ? new Date(conv.create_time * 1000) : null;

    const headerParts = ['==== Диалог: ' + title];
    if (created){
      headerParts.push('(' + created.toLocaleString('ru-RU') + ')');
    }
    out.push(headerParts.join(' ') + ' ====');

    const mapping = conv.mapping || {};
    const nodes = Object.values(mapping)
      .filter(n => n && n.message && n.message.content)
      .sort((a,b)=>{
        const ta = (a.message && a.message.create_time) ? a.message.create_time : 0;
        const tb = (b.message && b.message.create_time) ? b.message.create_time : 0;
        return ta - tb;
      });

    for (const node of nodes){
      const m = node.message;
      if (!m) continue;

      const ts = m.create_time
        ? new Date(m.create_time * 1000).toLocaleString('ru-RU')
        : '';

      let role = (m.author && m.author.role) ? m.author.role : 'unknown';
      if (role === 'assistant') role = 'ChatGPT';
      else if (role === 'user') role = 'Пользователь';
      else if (role === 'system') role = 'Система';

      let text = '';
      const c = m.content;
      if (c){
        if (Array.isArray(c.parts)){
          text = c.parts.join('\n');
        } else if (typeof c === 'string'){
          text = c;
        } else if (c.text){
          text = c.text;
        }
      }
      if (!String(text || '').trim()) continue;

      out.push((ts ? '[' + ts + '] ' : '') + role + ':\n' + text + '\n');
    }

    out.push('');
  }

  return out.join('\n');
}

// === Installer Copilot (static guide; NOT using KB/DB as knowledge) ===
const COPILOT_GUIDE_PATH = path.join(__dirname, 'copilot_installer_ru.md');

// 1) Источник знаний: один файл-инструкция (постоянный)
let COPILOT_GUIDE_RU = '';
try {
  COPILOT_GUIDE_RU = fs.readFileSync(COPILOT_GUIDE_PATH, 'utf8');
} catch (e) {
  // fallback — если файл ещё не создали
  COPILOT_GUIDE_RU = `
# NeDzat / SatuBooster — инструкция установщика (кратко)

## Быстрый старт
- Установи Node.js LTS, PM2, Nginx, Certbot.
- Склонируй проект, заполни .env, запусти через PM2.
- В Nginx проксируй на порт приложения, включи SSL.
- В панели добавь WhatsApp аккаунт, отсканируй QR.

## AI агент
- Включи AI на нужном WhatsApp аккаунте.
- Задай System prompt, модель, контекст, задержку.
- Стоп-слово/старт-слово: для управления менеджером.
- Follow-up: либо шаблонный, либо AI follow-up.

## Типовые проблемы
- Не отправляет в WhatsApp: проверь статус аккаунта, сессию, логи PM2, сеть, лимиты.
- Не приходит письмо: проверь SMTP env/домен/спам.
- Домен/SSL: проверь A-запись, Nginx server_name, certbot.
`;
}

function cpNormalize(text){
  return String(text||'')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function cpTokenize(text){
  const s = cpNormalize(text);
  if (!s) return [];
  const words = s.split(' ').filter(Boolean);

  const out = [];
  for (const w of words){
    if (w.length >= 3) out.push(w);
    else if (w === 'ии' || w === 'ai') out.push(w); // важно для коротких запросов
  }
  return out.slice(0, 80);
}

function cpSplitToChunks(md){
  const raw = String(md||'').replace(/\r/g,'').trim();
  if (!raw) return [];
  // режем по заголовкам или большим пустым блокам
  const parts = raw
    .split(/\n(?=##\s)|\n{3,}/g)
    .map(x => x.trim())
    .filter(Boolean);

  // дополнительно ограничим размер куска
  const out = [];
  for (const p of parts){
    if (p.length <= 1400) out.push(p);
    else {
      // крупные куски режем
      for (let i=0;i<p.length;i+=1200){
        out.push(p.slice(i, i+1200).trim());
      }
    }
  }
  return out.filter(Boolean);
}

const CP_CHUNKS = cpSplitToChunks(COPILOT_GUIDE_RU);

function cpPickContext(question, topN=6){
  const qTokens = new Set(cpTokenize(question));
  if (!qTokens.size) return '';

  const scored = CP_CHUNKS.map((chunk) => {
    const cTokens = cpTokenize(chunk);
    let score = 0;
    for (const t of cTokens) if (qTokens.has(t)) score++;
    // лёгкий бонус заголовкам
    if (/^##\s/m.test(chunk)) score += 1;
    return { chunk, score };
  }).filter(x => x.score > 0)
    .sort((a,b)=>b.score-a.score)
    .slice(0, Math.max(1, Math.min(10, topN)));

  return scored.map(x => x.chunk).join('\n\n---\n\n');
}

// 2) API: отвечает только по инструкции установщика
app.post('/api/copilot/ask', authGuard, async (req,res) => {
  try{
    const q = String(req.body?.q || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!q) return res.status(400).json({ ok:false, error:'q is required' });

    // ключ: сначала глобальный, иначе tenant-key (как в проекте)
    const tid = req.user?.tenant_id || 1;

    const openaiKey = process.env.OPENAI_API_KEY || await getOpenAIKeyForTenant(tid);
    if (!openaiKey){
      // даже без OpenAI вернём "полезный" контекст (не молчим)
      const ctx = cpPickContext(q, 8);
      return res.json({
        ok:true,
        answer: ctx ? ('Вот что есть в инструкции:\n\n' + ctx) : 'Нет OpenAI ключа и не нашёл совпадений в инструкции. Добавь OPENAI_API_KEY в .env или уточни вопрос.'
      });
    }

    const ctx = cpPickContext(q, 6);

    const sys = [
      'Ты SatuBooster AI (SAI) — помощник пользователя по интерфейсу и функциям панели.',
      'Отвечай ТОЛЬКО по базе знаний ниже. Не придумывай функции.',
      'Если в базе знаний нет ответа — скажи: "В базе знаний пока нет этого пункта" и предложи, где в панели это обычно находится или что уточнить у администратора.',
      'Пиши коротко, по шагам, без технических терминов (PM2/Nginx/сервер не упоминать).',
      '',
      '=== БАЗА ЗНАНИЙ ===',
      ctx || '(в базе знаний нет релевантного фрагмента по этому вопросу)'
    ].join('\n');


    const msgs = [];
    // берём немного истории, чтобы ответы были “как в диалоге”
    for (const m of history.slice(-30)){
      const role = (m && m.role === 'assistant') ? 'assistant' : 'user';
      const content = String(m?.content || '').trim();
      if (content) msgs.push({ role, content: content.slice(0, 1500) });
    }
    msgs.push({ role:'user', content: q });

    const openai = new OpenAI({ apiKey: openaiKey });

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 450,
      messages: [{ role:'system', content: sys }, ...msgs]
    });

    const answer = String(r.choices?.[0]?.message?.content || '').trim();
    res.json({ ok:true, answer });
  } catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// === KB: ingest файлов (Excel/Word/PDF/PPTX/URL) ===
app.post('/api/kb/ingest', authGuard, requireFeature(FEATURES.KB), async (req,res)=>{
  try{
    const relRaw   = String(req.body?.file  || '').trim();  // 'uploads/xxx.ext'
    const urlRaw   = String(req.body?.url   || '').trim();  // 'https://...'
    const manuTitl = String(req.body?.title || '').trim();  // опциональный заголовок

    if (!relRaw && !urlRaw){
      return res.status(400).json({ok:false, error:'file or url is required'});
    }

    let fullText       = '';
    let fileKind       = '';
    let filenameStored = '';
    let title          = '';

    // ---------- Вариант 1: URL ----------
    if (urlRaw){
      let u;
      try{
        u = new URL(urlRaw);
      }catch(_){
        return res.status(400).json({ok:false, error:'bad url'});
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:'){
        return res.status(400).json({ok:false, error:'only http/https urls allowed'});
      }

      const resp = await fetchWithTimeout(urlRaw, {}, 15000).catch(()=>null);
      if (!resp || !resp.ok){
        return res.status(400).json({ok:false, error:'cannot fetch url'});
      }

      const html = await resp.text();
      fullText = htmlToText(html);
      if (!fullText){
        return res.status(400).json({ok:false, error:'no text extracted from url'});
      }

      fileKind       = 'url';
      filenameStored = urlRaw;
      title = manuTitl || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || urlRaw);
      title = title.trim();

    // ---------- Вариант 2: файл из uploads/ ----------
    } else {
      const rel = relRaw;

      if (!rel.startsWith('uploads/')){
        return res.status(400).json({ok:false, error:'bad file path'});
      }
      const abs = path.join(__dirname, rel);
      if (!fs.existsSync(abs)){
        return res.status(404).json({ok:false, error:'file not found'});
      }

      const ext = path.extname(abs).toLowerCase();

      // --- Excel / CSV ---
      if (ext === '.xlsx' || ext === '.xls' || ext === '.csv'){
        const wb = XLSX.read(fs.readFileSync(abs), { type: 'buffer' });

        const parts = [];
        wb.SheetNames.forEach(name=>{
          const ws = wb.Sheets[name];
          if (!ws) return;
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (rows.length){
            parts.push(`### Лист: ${name}`);
            for (const row of rows){
              const line = row.map(v => String(v)).join(' | ').trim();
              if (line) parts.push(line);
            }
          }
        });

        fullText       = parts.join('\n');
        fileKind       = ext === '.csv' ? 'csv' : 'xlsx';
        filenameStored = rel;

      // --- PDF ---
      } else if (ext === '.pdf'){
        const buf    = await fsp.readFile(abs);
        const parsed = await pdfParse(buf);
        fullText     = String(parsed?.text || '').trim();
        fileKind       = 'pdf';
        filenameStored = rel;

      // --- DOCX / PPTX ---
      } else if (ext === '.docx' || ext === '.pptx'){
        if (!officeParser || !(officeParser.parseOfficeAsync || officeParser.parseOffice || officeParser.parseDocx)){
          return res.status(500).json({
            ok:false,
            error:'DOCX/PPTX support requires officeparser. Run: npm install officeparser'
          });
        }

        let data;
        if (officeParser.parseOfficeAsync){
          data = await officeParser.parseOfficeAsync(abs);
        } else if (officeParser.parseOffice){
          data = await new Promise((resolve, reject)=>{
            officeParser.parseOffice(abs, (err, text)=>{
              if (err) reject(err); else resolve(text);
            });
          });
        } else if (ext === '.docx' && officeParser.parseDocx){
          data = await new Promise((resolve, reject)=>{
            officeParser.parseDocx(abs, (err, text)=>{
              if (err) reject(err); else resolve(text);
            });
          });
        }

        fullText       = String(data || '').trim();
        fileKind       = (ext === '.docx') ? 'docx' : 'pptx';
        filenameStored = rel;

      // --- обычный текст ---
      } else if (ext === '.txt' || ext === '.md'){
        const buf = await fsp.readFile(abs, 'utf8');
        fullText       = String(buf || '').trim();
        fileKind       = ext.slice(1); // 'txt' / 'md'
        filenameStored = rel;

              // --- ChatGPT export (.zip with conversations.json) ---
      } else if (ext === '.zip'){
        // читаем архив и ищем conversations.json
        const bufZip  = await fsp.readFile(abs);
        const zip     = new AdmZip(bufZip);
        const entries = zip.getEntries() || [];

        const convEntry = entries.find(e => /conversations\.json$/i.test(e.entryName));
        if (!convEntry){
          return res.status(400).json({
            ok:false,
            error:'zip does not look like ChatGPT export: conversations.json not found'
          });
        }

        let jsonRaw;
        try{
          jsonRaw = convEntry.getData().toString('utf8');
        }catch(e){
          return res.status(400).json({
            ok:false,
            error:'failed to read conversations.json from zip: ' + e.message
          });
        }

        let exportJson;
        try{
          exportJson = JSON.parse(jsonRaw);
        }catch(e){
          return res.status(400).json({
            ok:false,
            error:'failed to parse conversations.json: ' + e.message
          });
        }

        // превращаем все диалоги в один большой текст и дальше индексируем как обычный файл
        fullText       = flattenChatGptExport(exportJson);
        fileKind       = 'chatgpt_export';
        filenameStored = rel;

      } else {
        return res.status(400).json({
          ok:false,
          error:'unsupported file type for KB (xlsx,xls,csv,docx,pptx,pdf,txt,md,zip, or url)'
        });
      }

      title = manuTitl || path.basename(abs);
    }

    fullText = String(fullText || '').trim();
    if (!fullText){
      return res.status(400).json({ok:false, error:'empty text after parsing'});
    }

    const chunks = chunkText(fullText, 3800);
    if (!chunks.length){
      return res.status(400).json({ok:false, error:'nothing to index'});
    }

    // создаём запись-файл
    const ins = await run(
      `INSERT INTO kb_files(tenant_id,filename,title,file_kind,uploaded_at) VALUES(?,?,?,?,?)`,
      [req.user.tenant_id, filenameStored, title, fileKind, Date.now()]
    );
    const file_id = ins.lastID;

    // эмбеддинги
    const openaiKey = await getOpenAIKeyForTenant(req.user.tenant_id);
    if (!openaiKey){
      return res.status(400).json({ok:false, error:'OpenAI key is required in settings'});
    }

    let idx = 0;
    for (const ch of chunks){
      const emb = await getEmbedding(openaiKey, ch);
      await run(
        `INSERT INTO kb_chunks(tenant_id,file_id,chunk_index,text,tokens,embedding) VALUES(?,?,?,?,?,?)`,
        [req.user.tenant_id, file_id, idx++, ch, roughTokenCount(ch), JSON.stringify(emb)]
      );
    }

    res.json({ok:true, file_id, chunks: chunks.length});
  }catch(e){
    console.error('KB ingest error:', e);
    res.status(500).json({ok:false, error:e.message});
  }
});

app.get('/api/kb/files', authGuard, requireFeature(FEATURES.KB), async (req,res)=>{
  const rows = await all(`SELECT f.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.file_id=f.id) chunks
                          FROM kb_files f WHERE tenant_id=? ORDER BY uploaded_at DESC`, [req.user.tenant_id]);
  res.json(rows);
});

// Скачать исходный файл из базы знаний
app.get('/api/kb/files/:id/download', authGuard, async (req, res) => {
  try {
    const tenant_id = req.user?.tenant_id;
    const id = Number(req.params.id || 0);
    if (!tenant_id || !id) return res.status(400).send('bad_request');

    // Берём запись файла (важно: проверка tenant_id)
    const row = await get(
      `SELECT id, title, filename, file_kind
       FROM kb_files
       WHERE id=? AND tenant_id=?`,
      [id, tenant_id]
    );

    if (!row) return res.status(404).send('not_found');

    // Если это URL — просто редиректим на ссылку
    if (String(row.file_kind || '') === 'url') {
      const url = String(row.filename || '').trim();
      if (/^https?:\/\//i.test(url)) return res.redirect(url);
      return res.status(400).send('bad_url');
    }

    // Обычный загруженный файл (uploads/....)
    let rel = String(row.filename || '').replace(/^\/+/, ''); // на всякий
    const uploadsBase = path.resolve(__dirname, 'uploads');
    const abs = path.resolve(__dirname, rel);

    // защита от path traversal: разрешаем только внутри ./uploads
    if (!(abs === uploadsBase || abs.startsWith(uploadsBase + path.sep))) {
      return res.status(403).send('forbidden');
    }

    if (!fs.existsSync(abs)) return res.status(404).send('file_missing');

    // красивое имя файла для скачивания
    const niceName =
      (String(row.title || '').trim() || require('path').basename(rel));

    return res.download(abs, niceName);
  } catch (e) {
    console.error('[KB][download] error:', e);
    return res.status(500).send('server_error');
  }
});

app.delete('/api/kb/files/:id', authGuard, async (req,res)=>{
  const id = Number(req.params.id);
  const own = await get(`SELECT id FROM kb_files WHERE id=? AND tenant_id=?`, [id, req.user.tenant_id]);
  if (!own) return res.status(404).json({ok:false, error:'not found'});
  await run(`DELETE FROM kb_chunks WHERE file_id=?`, [id]);
  await run(`DELETE FROM kb_files WHERE id=?`, [id]);
  res.json({ok:true});
});

function cosine(a,b){
  if (!a || !b || a.length!==b.length) return 0;
  let dot=0, na=0, nb=0;
  for(let i=0;i<a.length;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return (na&&nb)?(dot/Math.sqrt(na*nb)):0;
}

async function kbSearch(tenantId, openaiKey, query, topK=5){
  const qEmb = await getEmbedding(openaiKey, query);
  const rows = await all(`SELECT id,text,embedding FROM kb_chunks WHERE tenant_id=?`, [tenantId]);
  const scored = rows.map(r=>{
    let emb = [];
    try{ emb = JSON.parse(r.embedding||'[]'); }catch(_){}
    return { id:r.id, text:r.text, score: cosine(qEmb, emb) };
  }).sort((a,b)=>b.score-a.score).slice(0, Math.max(1, Math.min(10, topK)));
  return scored;
}

// -------------------------------------------------
// Block helpers
// -------------------------------------------------
async function setBlock(accId, jid, minutes) {
  const tenantId = await getAccTenant(accId);
  const key = `${accId}:${jid}`;
  if (minutes > 0) {
    await run(`INSERT OR REPLACE INTO blocks(tenant_id,jid,until) VALUES(?,?,?)`, [tenantId, key, nowSec() + minutes * 60]);
  } else {
    await run(`DELETE FROM blocks WHERE tenant_id=? AND jid=?`, [tenantId, key]);
  }
}
async function isBlocked(accId, jid) {
  const tenantId = await getAccTenant(accId);
  const key = `${accId}:${jid}`;
  const b = await get(`SELECT until FROM blocks WHERE tenant_id=? AND jid=?`, [tenantId, key]);
  return !!(b && b.until > nowSec());
}

// --- Permanent AI ignore helpers (by account) ---
const PERMANENT_MINUTES = 60 * 24 * 365 * 100; // ~100 лет

/** Добавить номер в вечный ignore для конкретного аккаунта */
async function addPermanentIgnore(accId, input){
  const jid = String(input||'').includes('@') ? String(input) : toWaJid(input);
  if (!jid) throw new Error('bad phone/jid');
  await setBlock(accId, jid, PERMANENT_MINUTES);
  return jid;
}

/** Убрать номер из ignore для конкретного аккаунта */
async function removePermanentIgnore(accId, input){
  const jid = String(input||'').includes('@') ? String(input) : toWaJid(input);
  if (!jid) throw new Error('bad phone/jid');
  await setBlock(accId, jid, 0);
  return jid;
}

/** Список игноров по аккаунту (только активные) */
async function listPermanentIgnores(accId){
  const tenantId = await getAccTenant(accId);
  const rows = await all(
    `SELECT jid, until FROM blocks WHERE tenant_id=? AND jid LIKE ? AND until > ? ORDER BY jid`,
    [tenantId, `${accId}:%`, nowSec()]
  );
  // rows[].jid хранится как `${accId}:${realJid}` — вернём "чистые" JID'ы
  return rows.map(r => {
    const raw = String(r.jid||'');
    const real = raw.replace(/^(\d+):/,''); // снять префикс accId:
    return { jid: real, phone: real.replace(/@.*/,'') };
  });
}

// -------------------------------------------------
// Accounts / sockets / runtime
// -------------------------------------------------
const sockets = new Map(); // accId -> { sock, stopping, tenantId }
// Telegram bots runtime
// accId -> { token, tenantId, stopping, offset }
const tgBots = new Map();
const lastQRMap = new Map(); // accId -> qr
const startingAccounts = new Set(); // защита от параллельных startAccount(accId)

// Exponential backoff для стабильных реконнектов
const reconnectAttempts = new Map();
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 300000;

async function isAccReady(accId){
  try{
    const row = await get(`SELECT kind, status, waba_enabled FROM accounts WHERE id=?`, [accId]);
    if (!row) return false;
    if (row.status !== 'online') return false;

    const kind = String(row.kind || 'wa').toLowerCase();
    if (kind === 'tg' || kind === 'telegram') {
      if (tgBots.has(accId)) return true;
      const rowTg = await get(`SELECT tg_token FROM accounts WHERE id=?`, [accId]);
      return !!String(rowTg?.tg_token || '').trim();
    }
    // ✅ WABA считаем готовым без Baileys-сокета
    if (Number(row.waba_enabled) === 1) return true;
    // WA
    const rec = sockets.get(accId);
  if (rec?.presenceInterval) { try { clearInterval(rec.presenceInterval); } catch(_) {} }
    return !!rec?.sock;
  }catch(_){
    return false;
  }
}

async function listAccountsByTenant(tid){
  return all(`SELECT id,label,folder,me_jid,status,model,temperature,max_tokens,forced_lang,ai_enabled,kind,tg_username
              FROM accounts WHERE tenant_id=? AND COALESCE(status,'')!='merged' ORDER BY id`, [tid]);
}
async function listOrphanAccIdsByTenant(tid){
  // acc_id, которые есть в profiles/chats, но уже отсутствуют в accounts
  const haveRows = await all(`SELECT id FROM accounts WHERE tenant_id=?`, [tid]);
  const have = new Set(haveRows.map(r => Number(r.id)));

  const used = await all(`
    SELECT DISTINCT acc_id AS id FROM profiles WHERE tenant_id=?
    UNION
    SELECT DISTINCT acc_id AS id FROM chats    WHERE tenant_id=?
  `, [tid, tid]);

  return used
    .map(r => Number(r.id))
    .filter(id => id && !have.has(id));
}

async function listAccountsByTenantWithOrphans(tid){
  const accs = await listAccountsByTenant(tid);
  const orphans = await listOrphanAccIdsByTenant(tid);

  for (const id of orphans){
    accs.push({
      id,
      label: `Удалённый аккаунт #${id}`,
      folder: '',
      me_jid: null,
      status: 'deleted',
      model: '',
      temperature: null,
      max_tokens: null,
      forced_lang: '',
      ai_enabled: 0,
      orphan: 1
    });
  }
  return accs;
}
async function listAllAccountsIds(){
  const rows = await all(`SELECT id FROM accounts WHERE COALESCE(status,'')!='merged' ORDER BY id`);
  return rows.map(r=>r.id);
}

async function resolveActiveWaAccId(tid, accId){
  try{
    if (await isAccReady(accId)) return accId;

    const row = await get(`SELECT me_jid, kind FROM accounts WHERE tenant_id=? AND id=?`, [tid, accId]);
    const me = String(row?.me_jid || '').trim();
    const kind = String(row?.kind || 'wa').toLowerCase();

    if (!me || !(kind === 'wa' || kind === 'whatsapp')) return accId;

    const cands = await all(
      `SELECT id FROM accounts
       WHERE tenant_id=? AND me_jid=? AND COALESCE(status,'')='online' AND COALESCE(status,'')!='merged'
       ORDER BY id DESC`,
      [tid, me]
    );

    for (const c of cands){
      const id2 = Number(c.id);
      if (id2 && await isAccReady(id2)) return id2;
    }
    return accId;
  }catch(_){
    return accId;
  }
}

async function mergeWaDuplicatesByMeJid(tid, primaryAccId, meJid){
  const me = String(meJid || '').trim();
  if (!me || !me.endsWith('@s.whatsapp.net')) return;

  // найдём дубликаты этого же номера
  const dupes = await all(
    `SELECT id FROM accounts
     WHERE tenant_id=? AND id<>?
       AND (lower(COALESCE(kind,'wa')) IN ('wa','whatsapp'))
       AND me_jid=?
       AND COALESCE(status,'')!='merged'
     ORDER BY id`,
    [tid, primaryAccId, me]
  );
  if (!dupes.length) return;

  await run('BEGIN');
  try{
    for (const d of dupes){
      const oldId = Number(d.id);
      if (!oldId) continue;

      // 1) chats — просто переносим acc_id
      await run(`UPDATE chats SET acc_id=? WHERE tenant_id=? AND acc_id=?`, [primaryAccId, tid, oldId]);

      // 2) profiles — безопасно (PK), поэтому INSERT OR IGNORE + DELETE старых
      await run(
        `INSERT OR IGNORE INTO profiles(
          tenant_id, acc_id, jid,
          name, city, budget, interest,
          notes, lang, last_intent, summary,
          stage, slots_updated_at,
          crm_id, crm_url
        )
        SELECT
          tenant_id, ?, jid,
          name, city, budget, interest,
          notes, lang, last_intent, summary,
          stage, slots_updated_at,
          crm_id, crm_url
        FROM profiles
        WHERE tenant_id=? AND acc_id=?`,
        [primaryAccId, tid, oldId]
      );
      await run(`DELETE FROM profiles WHERE tenant_id=? AND acc_id=?`, [tid, oldId]);

      // 3) followups
      await run(
        `INSERT OR IGNORE INTO followups(tenant_id, acc_id, jid, step, sent_ts)
         SELECT tenant_id, ?, jid, step, sent_ts
         FROM followups WHERE tenant_id=? AND acc_id=?`,
        [primaryAccId, tid, oldId]
      );
      await run(`DELETE FROM followups WHERE tenant_id=? AND acc_id=?`, [tid, oldId]);

      // 4) firstmsg_state
      await run(
        `INSERT OR IGNORE INTO firstmsg_state(tenant_id, acc_id, jid, state, created_ts, sent_ts, done_ts)
         SELECT tenant_id, ?, jid, state, created_ts, sent_ts, done_ts
         FROM firstmsg_state WHERE tenant_id=? AND acc_id=?`,
        [primaryAccId, tid, oldId]
      );
      await run(`DELETE FROM firstmsg_state WHERE tenant_id=? AND acc_id=?`, [tid, oldId]);

      // 5) firstmsg_jobs / escalations / receipts — можно просто UPDATE
      await run(`UPDATE firstmsg_jobs SET acc_id=? WHERE tenant_id=? AND acc_id=?`, [primaryAccId, tid, oldId]);
      await run(`UPDATE escalations  SET acc_id=? WHERE tenant_id=? AND acc_id=?`, [primaryAccId, tid, oldId]);
      await run(`UPDATE receipts     SET acc_id=? WHERE tenant_id=? AND acc_id=?`, [primaryAccId, tid, oldId]);

      // 6) satu_leads — PK, поэтому INSERT OR IGNORE + DELETE
      await run(
        `INSERT OR IGNORE INTO satu_leads(tenant_id, acc_id, jid, month_key, first_ts)
         SELECT tenant_id, ?, jid, month_key, first_ts
         FROM satu_leads WHERE tenant_id=? AND acc_id=?`,
        [primaryAccId, tid, oldId]
      );
      await run(`DELETE FROM satu_leads WHERE tenant_id=? AND acc_id=?`, [tid, oldId]);

      // 7) помечаем старый аккаунт как "merged" (скрываем)
      await run(`UPDATE accounts SET status='merged', updated_at=? WHERE id=?`, [Date.now(), oldId]);
    }

    await run('COMMIT');
  }catch(e){
    await run('ROLLBACK');
    throw e;
  }

  // обновим список аккаунтов у фронта
  try{ await broadcastAccList(tid); }catch(_){}
}

async function setAccStatus(id, status, me_jid=null){
  const tid = await getAccTenant(id);

  // ✅ нормализуем me_jid, чтобы было "7747...@s.whatsapp.net" без ":52"
  const normMe = me_jid ? normalizeMeJid(me_jid) : null;

  await run(
    `UPDATE accounts SET status=?, me_jid=COALESCE(?,me_jid), updated_at=? WHERE id=?`,
    [status, normMe, Date.now(), id]
  );

    // если WA стал online — склеиваем дубликаты по одному и тому же номеру (me_jid)
    if (status === 'online' && normMe && normMe.endsWith('@s.whatsapp.net')) {
      try{
        await mergeWaDuplicatesByMeJid(tid, id, normMe);
      }catch(e){
        console.warn('[WA MERGE]', e?.message || e);
      }
    }

  io.to(`tenant_${tid}`).emit('acc:update',{id,status,me_jid:normMe||undefined});
}

async function broadcastAccList(tid){ io.to(`tenant_${tid}`).emit('acc:list', await listAccountsByTenant(tid)); }
async function rmrf(p){ try{ await fsp.rm(p,{recursive:true,force:true}); }catch(_){} }

async function getAccLLMConfig(accId){
  const acc = await get(`SELECT tenant_id,label,model,temperature,max_tokens,forced_lang FROM accounts WHERE id=?`, [accId]);
  const tid = Number(acc?.tenant_id || 1);
  const defModel = (await getSetting('default_model', tid)) || '';
  const model = defModel || acc?.model || 'gpt-4o';
  const temperature = Number(acc?.temperature ?? (await getSetting('default_temperature', tid)||0.7));
  const max_tokens  = parseInt(acc?.max_tokens ?? (await getSetting('default_max_tokens', tid)||200),10);
  const forced_lang = acc?.forced_lang || '';
  const label = acc?.label || '';
  return { model, temperature, max_tokens, forced_lang, label, tenant_id: tid };
}



// Debounce
const replyTimers = new Map();
const replyForces = new Map();
const replyInputKinds = new Map();
// In-flight lock for AI replies (prevents parallel duplicate sends)
const aiInFlight = new Set();
const _rk = (accId, jid) => `${accId}:${jid}`;

// -------------------------------------------------
// WhatsApp (Baileys) "typing" presence for leads
// Показывает клиенту в WhatsApp статус "печатает..." пока ИИ готовит ответ.
// Включаем ТОЛЬКО для Baileys (у WABA/TG нет sock в sockets).
// -------------------------------------------------
const waTypingLoops = new Map(); // k -> { interval, timeout, toJid }

async function startWATypingPresence(accId, jid){
  try {
    const rec = sockets.get(accId);
    const sock = rec?.sock;
    if (!sock || !sock.user?.id) return; // не Baileys / не готов

    const toJid = normalizeDirectJid(jid);
    if (!toJid) return;

    const k = _rk(accId, toJid);
    if (waTypingLoops.has(k)) return;

    const tick = async () => {
      try { await sock.sendPresenceUpdate('composing', toJid); } catch(_) {}
    };

    await tick();
    const interval = setInterval(tick, 7500); // поддерживаем "печатает" (WA гасит через ~5-10с)
    const timeout  = setTimeout(() => {
      stopWATypingPresence(accId, toJid).catch(()=>{});
    }, 15 * 60 * 1000); // страховка от "вечного" печатает

    waTypingLoops.set(k, { interval, timeout, toJid });
  } catch(_) {}
}

async function stopWATypingPresence(accId, jid){
  try {
    const toJid = normalizeDirectJid(jid) || String(jid||'');
    const k = _rk(accId, toJid);
    const h = waTypingLoops.get(k);
    if (h) {
      clearInterval(h.interval);
      clearTimeout(h.timeout);
      waTypingLoops.delete(k);
    }

    const rec = sockets.get(accId);
    const sock = rec?.sock;
    if (!sock || !sock.user?.id || !toJid) return;

    // "paused" + "available" — чтобы индикатор исчез точно
    try { await sock.sendPresenceUpdate('paused', toJid); } catch(_) {}
    try { await sock.sendPresenceUpdate('available', toJid); } catch(_) {}
  } catch(_) {}
}

function cancelAIReply(accId, jid){
  const k = _rk(accId, jid);
  const t = replyTimers.get(k);
  if (t) clearTimeout(t);
  replyTimers.delete(k);
  replyForces.delete(k);
}
async function scheduleAIReply(accId, jid, force){
  if(!(await isAIEnabledForAccount(accId))) return;
  const k = _rk(accId, jid);
  const { tenant_id } = await getAccLLMConfig(accId);
  if (force) replyForces.set(k, true);
  const prev = replyTimers.get(k);
  if (prev) clearTimeout(prev);
  const delaySec = force ? 0 : parseInt(await getSetting('delay_sec', tenant_id) || '2', 10);
  // WhatsApp lead sees "печатает..." во время delay_sec + генерации (Baileys)
  // (для WABA/TG startWATypingPresence просто ничего не сделает)
  startWATypingPresence(accId, jid).catch(()=>{});
  const handle = setTimeout(()=>{ sendAIReplyNow(accId, jid).catch(e=>console.error('sendAIReplyNow error', e)); }, Math.max(0, delaySec) * 1000);
  replyTimers.set(k, handle);
}

async function buildChatHistory(accId, jid){
  const { tenant_id } = await getAccLLMConfig(accId);
  const prompt  = await getSetting('system_prompt', tenant_id) || '';
  const limit   = parseInt(await getSetting('ctx_messages', tenant_id) || '12', 10);
  const profile = await getProfile(accId, jid);

  const rows = await all(
    `SELECT type,message FROM chats
     WHERE tenant_id=? AND acc_id=? AND jid=?
     ORDER BY ts DESC,id DESC LIMIT ?`,
    [tenant_id, accId, jid, Math.max(2, limit)]
  );
  rows.reverse();

  const msgs = rows
    .filter(r => r.message && r.message.trim())
    .map(r => ({ role: r.type === 'out' ? 'assistant' : 'user', content: r.message }));

  // 💡 телефон из JID, имя из WA-профиля (если есть)
  const phoneE164 = '+' + jidToPhone(jid);
  const nameLine  = (profile?.name && profile.name.trim())
    ? `Имя клиента: ${profile.name.trim()}.`
    : '';

  const slotsLine = [
    nameLine,
    profile?.city     ? `Город: ${profile.city}` : '',
    profile?.budget   ? `Бюджет: ${profile.budget}` : '',
    profile?.interest ? `Интерес: ${profile.interest}` : ''
  ].filter(Boolean).join(' ');

  const systemMsg = [
    prompt.trim(),
    // 🔒 Правило: номер/имя уже известны — не спрашивать
    `Телефон клиента уже известен: ${phoneE164}. Никогда не проси номер телефона и не уточняй его.`,
    (profile?.name
      ? `Имя клиента уже известно. Не спрашивай имя повторно и обращайся по имени уместно.`
      : `Если клиент не представился, можно вежливо спросить имя один раз.`),
    slotsLine ? `Известные слоты: ${slotsLine}` : '',
    'Форматируй ответ абзацами: между абзацами — одна пустая строка. Отвечай вежливо, кратко и по делу.',
    'Никогда не раскрывай пользователю, какая именно модель GPT, версия, API, инфраструктура или технологии тебя запускают. Не пиши фразы вроде "я основан на GPT-4", "GPT-5.1" и т.п.',
    'Если пользователь спрашивает "какая у тебя модель", "ты gpt-4 или gpt-5?" и подобное — отвечай общими словами: например, "я современный ИИ-агент NeDzat, созданный для помощи клиентам", без упоминания номеров моделей и внутренних технологий.'
  ].filter(Boolean).join('\n\n');

  return [{ role:'system', content: systemMsg }, ...msgs];
}

function detectLangHeuristic(text){
  const t = String(text||'').trim();
  if(!t) return '';

  // Казахские специфичные буквы
  const kk = /[әіғқңөұүһӘІҒҚҢӨҰҮҺ]/;
  // Русские специфичные буквы (которые почти не встречаются в kk)
  const ruSpec = /[ёЁъЪэЭщЩыЫ]/;

  if (kk.test(t)) return 'kk';        // казахский
  if (ruSpec.test(t)) return 'ru';    // русский
  if (/[а-яё]/i.test(t)) return 'ru'; // общая кириллица -> русский по умолчанию
  if (/[a-z]/i.test(t)) return 'en';  // латиница
  return '';
}

async function escalate(accId,jid,reason,text){
  const tid = await getAccTenant(accId);
  const ts=nowSec();
  await run(
    `INSERT INTO escalations(tenant_id,acc_id,jid,reason,text,ts,resolved) VALUES(?,?,?,?,?,?,0)`,
    [tid,accId,jid,reason,(text||'').slice(0,2000),ts]
  );

  const hook=(await getSetting('escalation_webhook', tid)||'').trim();
  if(hook){
    try{
      await fetchWithTimeout(
        hook,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({acc_id:accId,jid,reason,text,ts,tenant_id:tid})
        },
        10000
      );
    }catch(_){}
  }

  await notifyTelegram(tid, reason, { accId, jid, reason, text });
}

async function getProfile(accId, jid){
  const tenantId = await getAccTenant(accId);
  
  // ✅ Канонический jid для WhatsApp, чтобы не плодить дубликаты (@lid и т.п.)
  let jidCanon = String(jid || '').trim();
  try {
    const acc = await get(`SELECT kind FROM accounts WHERE id=? AND tenant_id=?`, [accId, tenantId]);
    const kind = String(acc?.kind || 'wa').toLowerCase();
    if (kind === 'wa' || kind === '') {
      jidCanon = normalizeDirectJid(jidCanon);
    }
  } catch(_) {}

  let p = await get(`SELECT * FROM profiles WHERE tenant_id=? AND acc_id=? AND jid=?`, [tenantId, accId, jidCanon]);
  if (!p) {
    await run(`INSERT OR IGNORE INTO profiles(tenant_id,acc_id,jid,stage,slots_updated_at)
               VALUES(?,?,?,?,?)`,[tenantId,accId,jidCanon,'unknown',nowSec()]);
    p = await get(`SELECT * FROM profiles WHERE tenant_id=? AND acc_id=? AND jid=?`, [tenantId, accId, jidCanon]);

  }
  return p;
}

async function saveProfile(accId, jid, patch){
  const tenantId = await getAccTenant(accId);
  
  // ✅ Канонический jid, чтобы profile сохранялся строго в одном виде
  let jidCanon = String(jid || '').trim();
  try {
    const acc = await get(`SELECT kind FROM accounts WHERE id=? AND tenant_id=?`, [accId, tenantId]);
    const kind = String(acc?.kind || 'wa').toLowerCase();
    if (kind === 'wa' || kind === '') {
      jidCanon = normalizeDirectJid(jidCanon);
    }
  } catch(_) {}

  const p = await getProfile(accId, jidCanon);

  // позволяем прокидывать crm_id и crm_url через patch
  const o = { ...p, ...patch };

  await run(
    `INSERT OR REPLACE INTO profiles(
       tenant_id, acc_id, jid,
       name, city, budget, interest,
       notes, lang, last_intent, summary,
       stage, slots_updated_at,
       crm_id, crm_url
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId, accId, jidCanon,
      o.name || '', o.city || '', o.budget || '', o.interest || '',
      o.notes || '', o.lang || '', o.last_intent || '', o.summary || '',
      o.stage || 'unknown',
      o.slots_updated_at || nowSec(),
      o.crm_id || '', o.crm_url || ''
    ]
  );
}

async function evaluateAndUpdateStage(accId, jid){
  const tenantId = await getAccTenant(accId);
  const gateOn = (await getSetting('fu_gate_enabled', tenantId)) === '1';
  if(!gateOn) return;

  const profile = await getProfile(accId, jid);
  const recent = await all(`SELECT type,message FROM chats WHERE tenant_id=? AND acc_id=? AND jid=? ORDER BY ts DESC,id DESC LIMIT 14`,[tenantId,accId,jid]);
  const text = recent.slice().reverse().map(r => (r.type==='in'?'Клиент: ':'Бот: ') + (r.message||'')).join('\n');
  const { fuDone, fuNoFollow } = await getPhraseLists(tenantId);

  const low = text.toLowerCase();
  if (includesPhrase(low, fuDone)) {
    if (profile.stage!=='booked') { 
      await saveProfile(accId,jid,{stage:'booked'}); 
      await notifyTelegram(tenantId,'booked', { accId, jid, stage:'booked', text:'фразы подтверждения/брони' });
    }
    return;
  }
  if (includesPhrase(low, fuNoFollow)) {
    if (profile.stage!=='not_interested') await saveProfile(accId,jid,{stage:'not_interested'});
    return;
  }
  if (includesPhrase(low, ['оператор','менеджер','живой человек','перезвоните','свяжитесь'])) {
    if (profile.stage!=='human_needed') { await saveProfile(accId,jid,{stage:'human_needed'}); await notifyTelegram(tenantId,'human_needed', { accId, jid, stage:'human_needed', text:'клиент просит менеджера' }); }
    return;
  }

  const key = await getOpenAIKeyForTenant(tenantId);
  if(!key){ if (profile.stage!=='unknown') await saveProfile(accId,jid,{stage:'unknown'}); return; }

  try{
    const openai=new OpenAI({apiKey:key});
    const resp=await openai.chat.completions.create({
      model:'gpt-4o-mini', temperature:0, max_tokens:80,
      messages:[
        {role:'system',content:`Ты классификатор стадии диалога. Верни ТОЛЬКО JSON без комментариев:
{"status": "unknown|need_identified|booked|not_interested|human_needed"}`},
        {role:'user',content:text}
      ]
    });
    const raw=(resp.choices?.[0]?.message?.content||'').trim();
    const js=JSON.parse(raw);
    const status = ['unknown','need_identified','booked','not_interested','human_needed'].includes(js.status)?js.status:'unknown';
    const prev = profile.stage || 'unknown';
    if (prev !== status) {
      await saveProfile(accId,jid,{stage:status});
      if (status==='booked' || status==='human_needed') await notifyTelegram(tenantId, status, { accId, jid, stage:status, text:'LLM-классификация' });
    }
  }catch(_){
    if (profile.stage!=='unknown') await saveProfile(accId,jid,{stage:'unknown'});
  }
}

function renderTextTemplate(str, profile={}, acc={}){
  const map = {
    name: profile.name||'',
    city: profile.city||'',
    budget: profile.budget||'',
    interest: profile.interest||'',
    acc_label: acc.label||'',
    lang: profile.lang||'',
    last_intent: profile.last_intent||''
  };
  return String(str||'').replace(/\{([a-z_]+)(?:\|([^}]+))?\}/gi, (_,k,defVal)=> (map[k] && String(map[k]).trim()) || (defVal||''));
}

async function generateAiFollowupText(tenantId, accId, jid, aiStyle=''){
  const openaiKey = await getOpenAIKeyForTenant(tenantId);
  if(!openaiKey) return ''; // нет ключа — молчим

  const { model, temperature } = (()=>{
    const m  = (getSetting('ai_fup_model', tenantId));       // промис!
    const t  = (getSetting('ai_fup_temperature', tenantId)); // промис!
    return { m, t };
  })();

  // подождём настройки
  const aiModel = (await model) || 'gpt-4o-mini';
  const aiTemp  = Number(await temperature || 0.5);
  const aiMax   = parseInt(await getSetting('ai_fup_max_tokens', tenantId) || '220', 10);

  // берём короткую историю переписки + профиль
  const profile  = await getProfile(accId, jid);
  const lastMsgs = await all(
    `SELECT type,message FROM chats WHERE tenant_id=? AND acc_id=? AND jid=? ORDER BY ts DESC,id DESC LIMIT 12`,
    [tenantId, accId, jid]
  );
  lastMsgs.reverse();
  const convo = lastMsgs.map(r => (r.type==='in'?'Клиент: ':'Бот: ') + (r.message||'')).join('\n');

  const summary = (profile?.summary||'').trim();
  const facts   = [
    profile?.name ? `Имя: ${profile.name}` : '',
    profile?.city ? `Город: ${profile.city}` : '',
    profile?.interest ? `Интерес: ${profile.interest}` : '',
    profile?.budget ? `Бюджет: ${profile.budget}` : '',
    profile?.stage ? `Стадия: ${profile.stage}` : ''
  ].filter(Boolean).join('; ');

  const system = [
    'Ты помогаешь менеджеру продавать в WhatsApp. Сделай короткий, дружелюбный дожим-сообщение (2–4 предложения).',
    'Цель: мягко подтолкнуть к следующему шагу (ответить, подтвердить, выбрать время, оплатить и т.п.).',
    'Без воды, без «извините», без канцелярита. Тон тёплый, конкретный, позитивный. Не используй эмодзи.',
    'Верни ТОЛЬКО текст сообщения без подсказок и пояснений.'
  ].join(' ');

  const style = (aiStyle||'').trim();
  const userPrompt = [
    style ? `Стиль/контекст: ${style}` : '',
    summary ? `Краткое резюме: ${summary}` : '',
    facts   ? `Факты: ${facts}` : '',
    '',
    'Диалог (последние реплики):',
    convo || '(пусто)'
  ].join('\n');

  try{
    const openai = new OpenAI({ apiKey: openaiKey });
    const resp = await openai.chat.completions.create({
      model: aiModel,
      temperature: isFinite(aiTemp)?aiTemp:0.5,
      max_tokens: Math.max(80, Math.min(aiMax, 400)),
      messages: [
        { role:'system', content: system },
        { role:'user',   content: userPrompt }
      ]
    });
    return (resp.choices?.[0]?.message?.content||'').trim();
  }catch(_){
    return '';
  }
}

async function listTemplates(tenantId){ return all(`SELECT * FROM msg_templates WHERE tenant_id=? ORDER BY updated_at DESC, id DESC LIMIT 200`, [tenantId]); }
async function getTemplate(tenantId, id){ return get(`SELECT * FROM msg_templates WHERE tenant_id=? AND id=?`, [tenantId, id]); }

async function sendAIReplyNow(accId, jid){
  const lockKey = _rk(accId, jid);
  if (aiInFlight.has(lockKey)) return;
  aiInFlight.add(lockKey);
  try {
    const k = lockKey;

  const forceReplyFlag = !!replyForces.get(k);

  // какой тип входящего был последним (перед дебаунсом)
  const inboundKind = replyInputKinds.get(k) || 'text'; // 'voice' | 'text'
  replyInputKinds.delete(k);

  if(!(await isAIEnabledForAccount(accId))) return;

  // WhatsApp lead sees "typing" while AI prepares (Baileys only)
  // (for WABA/TG this is a no-op)
  await startWATypingPresence(accId, jid);

  cancelAIReply(accId, jid);

  const { tenant_id } = await getAccLLMConfig(accId);
  if (await isBlocked(accId, jid)) return;

  const tenantId = Number(tenant_id || 1);

  // --- WA AI idempotency: ключ последнего входящего сообщения ---
  let dedupKey = '';
  try {
    const lastInMeta = await get(
      `SELECT wa_id, ts, message FROM chats
      WHERE tenant_id=? AND acc_id=? AND jid=? AND type='in'
      ORDER BY ts DESC, id DESC LIMIT 1`,
      [tenantId, accId, jid]
    );
    const w = String(lastInMeta?.wa_id || '').trim();
    if (w) {
      dedupKey = w;
    } else {
      const ts0 = Number(lastInMeta?.ts || 0) || 0;
      const sample = String(lastInMeta?.message || '').trim().slice(0, 64);
      if (ts0 || sample) dedupKey = `ts:${ts0}:${sample}`;
    }
  } catch (e) {
    console.warn('[AI][DEDUP_KEY_FAIL]', e?.message || e);
  }

  // 1) если лид уже оплачен в этом месяце — отвечаем всегда (даже при 0 балансе)
  const alreadyPaid = await isLeadPaidThisMonth({ tenantId, accId, jid });
  if (!alreadyPaid) {
    // 2) если лид новый для этого месяца — тогда требуем баланс и списываем
    await chargeSatuForLeadIfNeeded({ tenantId, accId, jid }); // :contentReference[oaicite:4]{index=4}
  }

  // SatuCoin: гейт + списание ДОЛЖНЫ быть ДО генерации/отправки (и до TTS voice_only тоже)
  try {
    await ensureSatuEnoughForChat(tenantId);
    await chargeSatuForLeadIfNeeded({ tenantId, accId, jid });
  } catch (err) {
    if (err?.code === 'SATU_NO_FUNDS') {
      logInfo('SatuCoin: not enough funds, skipping AI reply', { tenantId, jid });
      return;
    }
    throw err;
  }

  const accKind = await getAccKind(accId);
  
  let sock = null;
  let tgToken = '';
  let isWABA = false;

  if (accKind === 'tg') {
    const recTg = tgBots.get(accId);
    tgToken = recTg?.token || (await get(`SELECT tg_token FROM accounts WHERE id=?`, [accId]))?.tg_token || '';
    if (!tgToken) {
      console.warn('[AI][TG_NOT_READY] acc=%s jid=%s', accId, jid);
      try { await setAccStatus(accId, 'offline', null); } catch(_) {}
      return;
    }
    } else {
        // ⭐ ПРОВЕРЯЕМ WABA ИЛИ BAILEYS
        const accData = await get(
          `SELECT waba_enabled, waba_phone_number_id, waba_access_token FROM accounts WHERE id=?`,
          [accId]
        );
        
        if (accData && Number(accData.waba_enabled) === 1) {
          // ✅ WABA АККАУНТ
          isWABA = true;
          
          if (!accData.waba_phone_number_id || !accData.waba_access_token) {
            console.warn('[AI][WABA_NOT_CONFIGURED] acc=%s jid=%s', accId, jid);
            return;
          }
          
          console.log(`[AI][WABA] Using Meta Cloud API for acc=${accId}`);
          
        } else {
          // ✅ BAILEYS АККАУНТ
          const rec = sockets.get(accId);
          sock = rec?.sock;


          const wsState = sock?.ws?.readyState;

          if (!sock || !sock.user?.id || (typeof wsState === 'number' && wsState !== 1)) {
            console.warn('[AI][WA_NOT_READY] acc=%s jid=%s user=%s ws=%s',
              accId, jid, sock?.user?.id || '', String(wsState)
            );
            try { await setAccStatus(accId, 'offline', null); } catch(_) {}
            return;
          }
        }
      }

  const openaiKey = await getOpenAIKeyForTenant(tenant_id);
  if (accKind !== 'tg' && !sock && !isWABA) return;

  if (!openaiKey){
    const warn = '⚠️ SatuBooster: OpenAI API key не задан. Проверьте настройки.';
    if (accKind === 'tg') {
      const chatId = tgJidToChatId(jid);
      if (chatId) await tgSendLongText(tgToken, chatId, warn);
    } else if (isWABA) {
      // WABA: отправляем через Meta Cloud API
      try { await sendViaWABA(accId, jid, warn, '', ''); } catch(e) {}
    } else {
      // Baileys
      await sock.sendMessage(jid,{text:warn});
    }
    return;
  }

  const openai = new OpenAI({ apiKey: openaiKey });
  
  const { badwords } = await getPhraseLists(tenant_id);
  const llm = await getAccLLMConfig(accId);

  // const messages = await buildChatHistory(accId, jid);
  // const langToUse = llm.forced_lang || (await getProfile(accId, jid)).lang || 'ru';

  const messages = await buildChatHistory(accId, jid);

  // ➕ Подсказываем модели номер/имя ещё раз (safety)
  {
    const prof = await getProfile(accId, jid);
    const phoneE164 = String(jid||'').startsWith('tg:') ? ('TG ' + String(jid).slice(3)) : ('+' + jidToPhone(jid));
    messages.unshift({
      role:'system',
      content: [
        `Телефон клиента: ${phoneE164}. Никогда не проси номер телефона — он уже известен.`,
        (prof?.name ? `Имя клиента: ${prof.name}. Не спрашивай имя повторно; обращайся по имени уместно.` : '')
      ].filter(Boolean).join(' ')
    });
  }

  // Автовыбор языка: forced_lang > профиль > язык последнего входящего (эвристика) > (ничего)
  const prof = await getProfile(accId, jid);
  const autoOn = (await getSetting('lang_auto', tenant_id)) === '1';
  const forced = (llm.forced_lang || '').trim();
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const fallbackLang = detectLangHeuristic(lastUserMsg) || '';

    // --- Подмешиваем контекст из базы знаний (Excel/Word/PDF/ChatGPT export) ---
  let kbContextText = '';
  try {
    const kbTopK = parseInt(await getSetting('kb_top_k', tenant_id) || '3', 10);
    if (kbTopK > 0 && lastUserMsg) {
      const hits = await kbSearch(tenant_id, openaiKey, lastUserMsg, kbTopK);
      if (hits && hits.length) {
        const kbParts = [];
        for (let i = 0; i < hits.length; i++) {
          const t = String(hits[i].text || '').trim();
          if (!t) continue;
          kbParts.push(`Источник ${i + 1}:\n${t}`);
        }
        kbContextText = kbParts.join('\n\n---\n\n');
        // чтобы не раздуть контекст – режем до ~8000 символов
        if (kbContextText.length > 8000) {
          kbContextText = kbContextText.slice(0, 8000);
        }
      }
    }
  } catch (e) {
    console.warn('[KB] search failed:', e?.message || e);
  }

  if (kbContextText) {
    messages.unshift({
      role: 'system',
      content: [
        'Используй приведённые ниже фрагменты базы знаний (файлы Excel/Word/PDF/презентации и экспорт ChatGPT) как ОПОРНЫЙ источник фактов для ответа клиенту.',
        'Если информации в базе знаний недостаточно или она не по теме, честно скажи об этом и отвечай как обычно.',
        '',
        kbContextText
      ].join('\n\n')
    });
  }

const langToUse =
  forced ||
  (autoOn ? (prof.lang || fallbackLang || '') : ((await getSetting('tts_lang', tenant_id) || '').trim()));
    
  // Подсказываем модели язык ответа
  messages.unshift({
    role: 'system',
    content: langToUse
      ? `Всегда отвечай на языке: ${langToUse}.`
      : 'Всегда отвечай на языке последнего входящего сообщения клиента.'
  });

// теперь лимит — только из аккаунта; дефолт задаётся default_max_tokens при создании
// --- ограничение длины ответа ---
// если галочка выключена → работаем как раньше (только max_tokens из аккаунта)
// если включена → используем default_max_tokens как верхний лимит

const tokensLimitEnabled =
  (await getSetting('default_max_tokens_enabled', tenant_id)) === '1';

let finalMaxTokens;

if (tokensLimitEnabled) {
  // включили галочку — используем default_max_tokens
  const rawDefault = await getSetting('default_max_tokens', tenant_id);
  const defaultMax = parseInt(rawDefault || '600', 10);      // значение из настроек
  const safeDefault = Math.max(50, Math.min(defaultMax, 4000));

  // если у аккаунта есть свой max_tokens — учитываем его, но не даём превысить safeDefault
  const accMax = llm.max_tokens
    ? Math.max(50, Math.min(llm.max_tokens, 4000))
    : safeDefault;

  finalMaxTokens = Math.min(accMax, safeDefault);
} else {
  // галочка выключена — старое поведение:
  // используем max_tokens из аккаунта, а если нет — 200
  const base = llm.max_tokens || 200;
  finalMaxTokens = Math.max(50, Math.min(base, 4000));
}

// сколько брать за один «кусок» при потоковой генерации
// - если галочка ВКЛ → один вызов на весь лимит
// - если ВЫКЛ → несколько кусков с автопродолжением
const chunkTokens = tokensLimitEnabled
  ? finalMaxTokens
  : Math.round(finalMaxTokens * 0.7);

const maxParts = tokensLimitEnabled ? 1 : 4;

// UI: показываем "Печатает..." в chat.html
try { io.to(`tenant_${tenantId}`).emit('ui:typing', { acc_id: accId, jid, on: true }); } catch(_) {}

const { text: aiReplyRaw, usage: aiUsage } = await completeUntilDone(openai, messages, {
  model: llm.model || 'gpt-4o',
  temperature: llm.temperature ?? 0.7,
  chunkTokens,
  maxParts
});

let aiReply = aiReplyRaw;

// если ответ пришёл «простынёй», аккуратно расставим абзацы LLM-форматером
if (aiReply && !/\n{2,}/.test(aiReply) && aiReply.length > 280) {
  aiReply = await formatParagraphsLLM(openaiKey, aiReply, langToUse);
}

  if ((await getSetting('moderation_enabled', tenant_id))==='1' && includesPhrase(aiReply, badwords)){
    await escalate(accId, jid, 'out_moderation_block', aiReply);
    aiReply = 'Передам запрос менеджеру.';
  }
  // --- АНТИ-ДУБЛЬ: не слать тот же текст повторно (гонки/два триггера) ---
  if (await hasRecentlySent(tenant_id, accId, jid, aiReply, 90)) {
    return; // такой же ответ уже улетел недавно
  }

  // --- ПЕРСИСТЕНТНЫЙ ДЕДУП: один AI-ответ на одно входящее сообщение ---
  if (dedupKey) {
    try {
      const ins = await run(
        `INSERT OR IGNORE INTO ai_reply_dedup(tenant_id, acc_id, jid, in_wa_id, created_ts)
        VALUES(?,?,?,?,?)`,
        [tenantId, accId, jid, dedupKey, nowSec()]
      );
      if ((ins?.changes ?? 0) === 0) return; // уже отвечали на это входящее
    } catch (e) {
      console.warn('[AI][DEDUP_INSERT_FAIL]', e?.message || e);
    }
  }
  
  // === TTS: если включено, озвучим ответ ===
  try {
    const ttsEnabled = ((await getSetting('tts_enabled', tenant_id)) === '1');
    if (ttsEnabled && aiReply) {
      const openaiKey = await getOpenAIKeyForTenant(tenant_id);
      if (openaiKey) {
      const ttsModel = (await getSetting('tts_model', tenant_id)) || 'gpt-4o-mini-tts';
      const ttsVoice = (await getSetting('tts_voice', tenant_id)) || 'alloy';
      let ttsMode  = (await getSetting('tts_mode', tenant_id)) || 'smart';
      // legacy: раньше был режим both (текст+голос). Теперь запрещаем "both" и ведём себя как smart.
      if (ttsMode === 'both') ttsMode = 'smart';
      if (accKind === 'tg' && ttsMode === 'both') ttsMode = 'smart'; // TG: не шлём "both"
            const inboundIsVoice = (inboundKind === 'voice');

      // when to send voice
      const shouldSendVoice =
        (ttsMode === 'voice_only') ||
        (ttsMode === 'smart' && inboundIsVoice);

      // если включён автоязык — берём из профиля/последнего входящего; иначе — явное значение из настройки
      const ttsLangSetting = (await getSetting('tts_lang', tenant_id) || '').trim();
      const ttsLang = autoOn ? (prof.lang || fallbackLang || '') : ttsLangSetting;

      const ttsRate  = (await getSetting('tts_rate', tenant_id)) || '1.0';
      const ttsPitch = (await getSetting('tts_pitch', tenant_id)) || '0';

      if (shouldSendVoice) {
        const { oggPath, previewPath } = await synthesizeTTS(openaiKey, aiReply, {
          model: ttsModel, voice: ttsVoice, rate: ttsRate, pitch: ttsPitch, lang: ttsLang
        });

        // если режим voice_only ИЛИ smart+входящий голос — отправляем ТОЛЬКО голос и выходим
        if (ttsMode === 'voice_only' || (ttsMode === 'smart' && inboundIsVoice)) {
          if (accKind === 'tg') {
            await sendVoiceMessageTG({
              token: tgToken, tenantId: tenant_id, accId, jid,
              text: aiReply,
              mediaLocalPath: oggPath,
              previewLocalPath: previewPath
            });
          } else if (isWABA) {
            await sendVoiceMessageWABA({
              tenantId: tenant_id, accId, jid,
              text: aiReply,
              mediaLocalPath: oggPath,
              previewLocalPath: previewPath
            });
          } else {
            await sendVoiceMessage({
              sock, tenantId: tenant_id, accId, jid,
              text: aiReply,
              mediaLocalPath: oggPath,
              previewLocalPath: previewPath
            });
          }
          return; // не шлём текст ниже
        }
      }
      }
    }
  } catch (e) {
    console.warn('[TTS] error:', e?.message || e);
  }

  
  // ✅ FIX: раньше AI генерировался, но текст не отправлялся (поэтому "ИИ не отвечает")
  // Отправляем текстовый ответ + логируем в DB/CRM/UI (best-effort).
  if (aiReply && String(aiReply).trim()) {
    const tsOut = nowSec();
    const dateOut = new Date(tsOut * 1000).toISOString().slice(0,10);
    const extIdOut = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + '_' + Math.random());

    let waIdOut = '';

    try {
      if (accKind === 'tg') {
        const chatId = String(jid || '').startsWith('tg:') ? String(jid).slice(3) : String(jid || '');
        await tgSendLongText(tgToken, chatId, aiReply);
      } else if (isWABA) {
        const r = await sendViaWABA(accId, jid, aiReply, '', '');
        waIdOut = String(
          r?.messages?.[0]?.id ||
          r?.messageId ||
          r?.messageid ||
          r?.id ||
          ''
        );
      } else if (sock) {
        waIdOut = await sendLongText(sock, jid, aiReply, tenantId, accId);
      } else {
        console.warn('[AI][SEND] no channel sock', { accId, jid });
      }
    } catch (e) {
      console.error('[AI][SEND] failed:', e?.response?.data || e?.message || e);
    }

    // DB log (best-effort; schema can differ across versions)
    try {
      await run(
        `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id,wa_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, jid, dateOut, tsOut, aiReply, 'out', accId, '', '', extIdOut, waIdOut || null]
      );
    } catch (e) {
      try {
        await run(
          `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [tenantId, jid, dateOut, tsOut, aiReply, 'out', accId, '', '', extIdOut]
        );
      } catch (_) {}
    }

    // CRM push (best-effort)
    try {
      await pushMessageToCRM({
        tenant_id: tenantId,
        acc_id: accId,
        jid,
        direction: 'out',
        text: aiReply,
        media_file: '',
        media_kind: '',
        external_id: waIdOut || extIdOut
      });
    } catch (e) {
      console.warn('[CRM][AI] push failed:', e?.message || e);
    }

    // UI update
    try {
      const phoneResolvedUi = await resolvePhoneForAccJid(accId, jid);
      io.to(`tenant_${tenantId}`).emit('newchat', {
        acc_id: accId,
        jid,
        phone: phoneResolvedUi || '',
        text: aiReply,
        date: dateOut,
        media_file: '',
        media_kind: ''
      });
    } catch (_) {}
  }

await evaluateAndUpdateStage(accId, jid);

    } finally {
    try { await stopWATypingPresence(accId, jid); } catch(_) {}
    try { io.to(`tenant_${tenantId}`).emit('ui:typing', { acc_id: accId, jid, on: false }); } catch(_) {}
    aiInFlight.delete(lockKey);
  }
}

// -------------------------------------------------
// Telegram lifecycle (Bot Token)
// -------------------------------------------------
function normalizeTgJid(input){
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.startsWith('tg:')) return s;
  // allow digits-only as chat_id
  const digits = s.replace(/[^\d-]/g, '');
  if (!digits) return '';
  return 'tg:' + digits;
}
function tgJidToChatId(jid){
  const s = String(jid || '');
  if (!s.startsWith('tg:')) return null;
  const n = Number(s.slice(3));
  return Number.isFinite(n) ? n : null;
}

// ===== Telegram: download file to uploads/ =====
async function tgDownloadToUploads(token, fileId, extHint='') {
  const gf = await tgCall(token, 'getFile', { file_id: fileId });
  // tgCall() возвращает data.result, поэтому file_path лежит на верхнем уровне
  const filePath = gf?.file_path;
  if (!filePath) throw new Error('Telegram getFile: no file_path');

  const url  = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Telegram file download failed: ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());

  const extFromPath = (path.extname(filePath) || '').toLowerCase();
  const ext = (extHint || extFromPath || '.bin').replace(/[^.\w]/g, '');

  const base = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const abs  = path.join(UPLOAD_DIR, `${base}${ext}`);

  await fsp.writeFile(abs, buf);
  const rel = 'uploads/' + path.basename(abs);
  return { abs, rel, filePath };
}

async function tgCall(token, method, body, { isForm=false, timeoutMs=40000 } = {}){
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    const data = await res.json().catch(()=>null);
    if (!res.ok || !data || data.ok !== true) {
      const msg = data?.description || `TG_${method}_FAILED`;
      throw new Error(msg);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

async function tgSendLongText(token, chatId, text){
  const TG_MAX = 3500; // Telegram 4096, берём безопасно
  const full = String(text || '');
  if (!full.trim()) return;
  for (let i=0; i<full.length; i+=TG_MAX){
    const part = full.slice(i, i+TG_MAX);
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: part
    });
  }
}

async function tgSendMediaFromUploads(token, chatId, kind, relPath, caption){
  // relPath типа: "uploads/xxx.png" или "/uploads/xxx.png"
  const safeRel = String(relPath || '').replace(/^\/+/, '');
  const abs = path.join(process.cwd(), safeRel);
  if (!fs.existsSync(abs)) throw new Error('media not found');

  const buf = await fsp.readFile(abs);
  const filename = path.basename(abs);

  const ext = path.extname(filename).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    ext === '.mp4' ? 'video/mp4' :
    ext === '.mp3' ? 'audio/mpeg' :
    ext === '.ogg' ? 'audio/ogg' :
    'application/octet-stream';

  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', String(caption).slice(0, 900));

  const blob = new Blob([buf], { type: mime });

  let method = 'sendDocument';
  let field  = 'document';

  if (kind === 'image') { method = 'sendPhoto'; field = 'photo'; }
  else if (kind === 'video') { method = 'sendVideo'; field = 'video'; }
  else if (kind === 'video_note') { method = 'sendVideoNote'; field = 'video_note'; }
  else if (kind === 'audio') {
    // если ogg — лучше как voice
    if (ext === '.ogg') { method = 'sendVoice'; field = 'voice'; }
    else { method = 'sendAudio'; field = 'audio'; }
  }

  fd.append(field, blob, filename);
  await tgCall(token, method, fd, { isForm:true });
}

async function startTelegramAccount(accId){
  // защита от двойного старта
  if (tgBots.has(accId)) return;

  const acc = await get(`SELECT id, tenant_id, tg_token, tg_offset FROM accounts WHERE id=?`, [accId]);
  if (!acc) throw new Error('account not found');
  const tenantId = Number(acc.tenant_id || 1);

  const token = String(acc.tg_token || '').trim();
  if (!token) {
    await setAccStatus(accId, 'offline', 'NO_TG_TOKEN');
    return;
  }

  // проверка токена
  let me;
  try{
    me = await tgCall(token, 'getMe', {});
  }catch(e){
    await setAccStatus(accId, 'offline', 'BAD_TG_TOKEN');
    return;
  }

  const username = String(me?.username || '').trim();
  await run(
    `UPDATE accounts SET status='online', me_jid=?, tg_username=?, updated_at=? WHERE id=?`,
    [`tg:@${username || 'bot'}`, username || null, Date.now(), accId]
  );

  const rec = {
    token,
    tenantId,
    stopping: false,
    offset: Number(acc.tg_offset || 0)
  };
  tgBots.set(accId, rec);

  // long-poll loop
  (async ()=>{
    try{
      while(!rec.stopping){
        let updates = [];
        try{
          updates = await tgCall(token, 'getUpdates', {
            offset: rec.offset,
            timeout: 25,
            allowed_updates: ['message']
          }, { timeoutMs: 40000 }) || [];
        }catch(e){
          console.warn('[TG][getUpdates] acc=%s err=%s', accId, e?.message || e);
          await sleep(1500);
          continue;
        }

        if (!Array.isArray(updates) || updates.length === 0) continue;

        // обработка пачки
        for (const u of updates){
          const updId = Number(u?.update_id);
          if (Number.isFinite(updId)) rec.offset = Math.max(rec.offset, updId + 1);

          const msg = u?.message;
          if (!msg) continue;

          // не отвечаем в группах/каналах (по умолчанию)
          const chatType = String(msg?.chat?.type || '');
          if (chatType && chatType !== 'private') continue;

          const chatId = Number(msg?.chat?.id);
          if (!Number.isFinite(chatId)) continue;
          if (chatId < 0) continue; // группы/супергруппы

          // пропускаем ботов
          if (msg?.from?.is_bot) continue;

          const jid = `tg:${chatId}`;

          // текст / голос (ASR) / медиа
          let userText = '';
          let suppressAI = false;
          let inboundKind = 'text'; // 'text' | 'voice' (нужно для TTS smart)
          let media_file = '';
          let media_kind = '';
          const openaiKey = await getOpenAIKeyForTenant(tenantId);

          if (typeof msg.text === 'string' && msg.text.trim()) {
            userText = msg.text.trim();
            inboundKind = 'text';
          }
          else if (msg.voice || msg.audio) {
            inboundKind = 'voice';
            const fileId = msg.voice?.file_id || msg.audio?.file_id;
            userText = '[TG] Голосовое сообщение';

            const openaiKey = await getOpenAIKeyForTenant(tenantId);
            if (!openaiKey || !fileId) {
              suppressAI = true;
            } else {
              try {
                // Telegram voice обычно OGG/Opus; сохраняем в uploads/
                const dl = await tgDownloadToUploads(token, fileId, '.ogg');
                media_file = dl.rel;
                media_kind = 'audio';

                const t = await transcribeWithFallback(dl.abs, openaiKey);
                if (t && t.trim()) {
                  userText = t.trim();
                  suppressAI = false;
                } else {
                  suppressAI = true;
                  await tgSendLongText(token, chatId, '⚠️ Не удалось скачать/распознать голос. Отправьте текстом, пожалуйста.');
                }
              } catch (e) {
                suppressAI = true;
                console.warn('[TG][ASR] acc=%s jid=%s err=%s', accId, jid, e?.message || e);
                await tgSendLongText(token, chatId, '⚠️ Не удалось скачать/распознать голос. Отправьте текстом, пожалуйста.');
              }
            }
          }
          // PHOTO (Telegram)
          else if (msg.photo) {
            inboundKind = 'text';
            try {
              const ph = Array.isArray(msg.photo) ? msg.photo[msg.photo.length - 1] : msg.photo;
              const fileId = ph?.file_id;
              const caption = String(msg.caption || '').trim();

              if (!fileId) {
                userText = ['[Фото]', caption].filter(Boolean).join('\n');
                suppressAI = false;
              } else {
                const dl = await tgDownloadToUploads(token, fileId, '.jpg');
                media_file = dl.rel;
                media_kind = 'image';

                let vision = '';
                try {
                  if (openaiKey && !isGif) {
                    const openai = new OpenAI({ apiKey: openaiKey });
                    const dataURL = await fileToDataURL(dl.abs, 'image/jpeg');
                    const comp = await openai.chat.completions.create({
                      model: 'gpt-4o-mini',
                      temperature: 0.2,
                      max_tokens: 220,
                      messages: [{
                        role: 'user',
                        content: [
                          { type: 'text', text: 'Извлеки весь читаемый текст (OCR) и кратко опиши, что на фото. Верни короткий абзац.' },
                          { type: 'image_url', image_url: { url: dataURL } }
                        ]
                      }]
                    });
                    vision = sanitizeVisionText((comp.choices?.[0]?.message?.content || '').trim());
                  }
                } catch(e) {
                  console.warn('[TG][VISION][photo] error:', e?.message || e);
                }

                userText = ['[Фото]', caption, vision].filter(Boolean).join('\n');
                suppressAI = false;
              }
            } catch(e) {
              console.warn('[TG][PHOTO] error:', e?.message || e);
              userText = '[TG] Фото';
              suppressAI = true;
            }
          }

          // VIDEO (Telegram)
          else if (msg.video) {
            inboundKind = 'text';
            try {
              const fileId = msg.video?.file_id;
              const caption = String(msg.caption || '').trim();

              if (!fileId) {
                userText = ['[Видео]', caption].filter(Boolean).join('\n');
                suppressAI = false;
              } else {
                const dl = await tgDownloadToUploads(token, fileId, '.mp4');
                media_file = dl.rel;
                media_kind = 'video';

                const parts = ['[Видео]'];
                if (caption) parts.push(caption);

                // ASR (речь в видео)
                try {
                  if (openaiKey && !isGif) {
                    const speech = await transcribeWithFallback(dl.abs, openaiKey);
                    if (speech) parts.push('Речь: ' + speech);
                  }
                } catch(e) {
                  console.warn('[TG][ASR][video] error:', e?.message || e);
                }

                // VISION по кадру
                try {
                  if (openaiKey && !isGif) {
                    const frameJpg = await videoFirstFrameToJpg(dl.abs);
                    if (frameJpg) {
                      const openai = new OpenAI({ apiKey: openaiKey });
                      const dataURL = await fileToDataURL(frameJpg, 'image/jpeg');
                      const comp = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        temperature: 0.2,
                        max_tokens: 180,
                        messages: [{
                          role: 'user',
                          content: [
                            { type: 'text', text: 'Кратко опиши, что видно на кадре видео. Если есть текст на кадре — вытащи его (OCR).' },
                            { type: 'image_url', image_url: { url: dataURL } }
                          ]
                        }]
                      });
                      const v = sanitizeVisionText((comp.choices?.[0]?.message?.content || '').trim());
                      if (v) parts.push('Кадр: ' + v);
                    }
                  }
                } catch(e) {
                  console.warn('[TG][VISION][video] error:', e?.message || e);
                }

                userText = parts.join('\n');
                suppressAI = false;
              }
            } catch(e) {
              console.warn('[TG][VIDEO] error:', e?.message || e);
              userText = '[TG] Видео';
              suppressAI = true;
            }
          }

          // DOCUMENT: PDF (как чек/как текст) + остальные документы
          else if (msg.document) {
            inboundKind = 'text';
            try {
              const fileId   = msg.document.file_id;
              const fileName = String(msg.document.file_name || '').trim();
              const mime     = String(msg.document.mime_type || '').toLowerCase();

              const caption = String(msg.caption || '').trim();
              const lowerName = (fileName || '').toLowerCase();

              const isImgDoc =
                (mime && mime.startsWith('image/')) ||
                /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(lowerName);

              const isVidDoc =
                (mime && mime.startsWith('video/')) ||
                /\.(mp4|mov|webm|mkv|avi|3gp|m4v)$/i.test(lowerName);

              if (isImgDoc) {
                const dl = await tgDownloadToUploads(token, fileId, '.jpg');
                media_file = dl.rel;
                media_kind = 'image';

                let vision = '';
                try {
                  if (openaiKey && !isGif) {
                    const openai = new OpenAI({ apiKey: openaiKey });
                    const dataURL = await fileToDataURL(dl.abs, 'image/jpeg');
                    const comp = await openai.chat.completions.create({
                      model: 'gpt-4o-mini',
                      temperature: 0.2,
                      max_tokens: 220,
                      messages: [{
                        role: 'user',
                        content: [
                          { type: 'text', text: 'Извлеки текст (OCR) и кратко опиши, что на фото. Верни короткий абзац.' },
                          { type: 'image_url', image_url: { url: dataURL } }
                        ]
                      }]
                    });
                    vision = sanitizeVisionText((comp.choices?.[0]?.message?.content || '').trim());
                  }
                } catch(e) {
                  console.warn('[TG][VISION][doc-photo] error:', e?.message || e);
                }

                userText = ['[Фото]', caption, vision].filter(Boolean).join('\n');
                suppressAI = false;

              } else if (isVidDoc) {
                const dl = await tgDownloadToUploads(token, fileId, '.mp4');
                media_file = dl.rel;
                media_kind = 'video';

                const parts = ['[Видео]'];
                if (caption) parts.push(caption);

                try {
                  if (openaiKey && !isGif) {
                    const speech = await transcribeWithFallback(dl.abs, openaiKey);
                    if (speech) parts.push('Речь: ' + speech);
                  }
                } catch(e) {
                  console.warn('[TG][ASR][doc-video] error:', e?.message || e);
                }

                try {
                  if (openaiKey && !isGif) {
                    const frameJpg = await videoFirstFrameToJpg(dl.abs);
                    if (frameJpg) {
                      const openai = new OpenAI({ apiKey: openaiKey });
                      const dataURL = await fileToDataURL(frameJpg, 'image/jpeg');
                      const comp = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        temperature: 0.2,
                        max_tokens: 220,
                        messages: [{
                          role: 'user',
                          content: [
                            { type: 'text', text: 'Кратко опиши, что на кадре. Верни 1 абзац.' },
                            { type: 'image_url', image_url: { url: dataURL } }
                          ]
                        }]
                      });
                      const v = sanitizeVisionText((comp.choices?.[0]?.message?.content || '').trim());
                      if (v) parts.push('Кадр: ' + v);
                    }
                  }
                } catch(e) {
                  console.warn('[TG][VISION][doc-video] error:', e?.message || e);
                }

                userText = parts.join('\n');
                suppressAI = false;

              } else {

              const ext0 = path.extname(fileName || '');
              const isPdf = (mime === 'application/pdf') || /\.pdf$/i.test(fileName);
              const safeExt = (ext0 && ext0.length <= 8) ? ext0 : (isPdf ? '.pdf' : '.bin');

              const dl = await tgDownloadToUploads(token, fileId, safeExt);
              media_file = dl.rel;
              media_kind = isPdf ? 'pdf' : 'file';

              const receiptOcrEnabled = (await getSetting('receipt_ocr_enabled', tenantId)) === '1';

              if (isPdf) {
                const pdfText = await extractPdfText(dl.abs, openaiKey);

              if (receiptOcrEnabled) {
                let parsedSum = parseReceiptAmount(pdfText);
                if (!parsedSum && openaiKey) parsedSum = await tryLLMAmount(openaiKey, pdfText);

                if (parsedSum) {
                  await confirmReceipt(accId, jid, media_file, pdfText, parsedSum);
                  userText = `[Чек PDF]\nАвтоматически распознано: ${parsedSum.amount.toFixed(2)}${parsedSum.currency ? (' ' + parsedSum.currency) : ''}`;
                  suppressAI = true; // ✅ это чек
                } else {
                  // ✅ не чек — обычное чтение PDF и AI ответ
                  const maxChars = 4000;
                  const safeText = (pdfText || '').trim().slice(0, maxChars);
                  const title = (fileName || caption || '').trim();
                  userText = (title ? `[PDF] ${title}\n\n` : '[PDF]\n\n') + (safeText || '[Текст PDF распознать не удалось]');
                  suppressAI = false;
                }
              } else {
                // режим чеков выключен — отдаём текст PDF в ИИ
                const safeText = (pdfText || '').trim().slice(0, 4000);
                const title = String(msg.document.file_name || '').trim();
                userText = (title ? `[PDF] ${title}\n\n` : '[PDF]\n\n') + (safeText || '[Текст PDF распознать не удалось]');
                suppressAI = false;
              }
              } else {
                const txt = await extractOfficeText(dl.abs, fileName);
                const safeText = String(txt || '').trim().slice(0, 4000);

                if (safeText) {
                  userText = (fileName ? `[FILE] ${fileName}\n\n` : '[FILE]\n\n') + safeText;
                  suppressAI = false; // обычный AI-ответ
                } else {
                  suppressAI = true;
                  await tgSendLongText(token, chatId, '⚠️ Не удалось извлечь текст из документа. Отправьте PDF или текстом, пожалуйста.');
                  userText = (fileName ? `[FILE] ${fileName}` : '[FILE]');
                }
              }
            }
            } catch (e) {
              console.warn('[TG][DOC] error:', e?.message || e);
              suppressAI = true;
              try { await tgSendLongText(token, chatId, '⚠️ Не удалось обработать документ.'); } catch(_) {}
              userText = '[TG] Документ';
            }
          }
          else {
            userText = '[TG] Сообщение';
            suppressAI = true;
          }

          // имя
          const nm = [
            msg?.from?.first_name,
            msg?.from?.last_name
          ].filter(Boolean).join(' ').trim();

          // профиль + сохранить имя (если есть)
          try{
            await getProfile(accId, jid);
            if (nm) {
              const pNow = await getProfile(accId, jid);
              if (!pNow?.name) await saveProfile(accId, jid, { name: nm.slice(0,120) });
            }
          }catch(_){}

          // сброс followups при входящем (как WA)
          try{
            await run(`DELETE FROM followups WHERE tenant_id=? AND acc_id=? AND jid=?`, [tenantId, accId, jid]);
          }catch(_){}

          // лог в chats
          const ts = nowSec();
          const date = new Date(ts*1000).toISOString().slice(0,10);
          await run(
            `INSERT OR IGNORE INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,wa_id)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [tenantId, jid, date, ts, userText, 'in', accId, media_file || '', media_kind || '', null]
          );

          // realtime в UI
          io.to(`tenant_${tenantId}`).emit('newchat',{
            acc_id: accId,
            jid,
            phone: String(chatId),
            text: userText,
            date,
            media_file: media_file || '',
            media_kind: media_kind || ''
          });

          // --- [FIRST MESSAGE TEMPLATE][TG] /start -> ставим в очередь "первое сообщение"
          try {
            const fmOn = (await getSetting('first_message_enabled', tenantId)) === '1';
            if (fmOn) {
              const st = await get(
                `SELECT state FROM firstmsg_state WHERE tenant_id=? AND acc_id=? AND jid=?`,
                [tenantId, accId, jid]
              );

              const raw = (typeof msg.text === 'string') ? msg.text.trim() : '';
              const low = raw.toLowerCase();
              const isStartCmd = low === '/start' || low.startsWith('/start ');

              const fmText = String(await getSetting('first_message_text', tenantId) || '').trim();
              const fmFile = String(await getSetting('first_message_media_file', tenantId) || '').trim();
              let fmKind = String(await getSetting('first_message_media_kind', tenantId) || '').trim().toLowerCase();
              if (!['image','video','audio','video_note',''].includes(fmKind)) fmKind = '';
              const hasContent = !!(fmText || fmFile);

              if (!st && isStartCmd && hasContent) {
                const delay = Math.max(0, Math.min(600, parseInt(await getSetting('first_message_delay_sec', tenantId) || '0', 10) || 0));
                const dueTs = nowSec() + delay;

                await run(
                  `INSERT OR IGNORE INTO firstmsg_state(tenant_id, acc_id, jid, state, created_ts)
                  VALUES(?,?,?,?,?)`,
                  [tenantId, accId, jid, 'pending', nowSec()]
                );

                await run(
                  `INSERT INTO firstmsg_jobs(tenant_id, acc_id, jid, due_ts, status, text, media_file, media_kind, created_ts)
                  VALUES(?,?,?,?,?,?,?,?,?)`,
                  [tenantId, accId, jid, dueTs, 'pending', fmText, fmFile, fmKind, nowSec()]
                );

                suppressAI = true; // пока шаблон не ушёл — AI молчит
              } else if (st?.state === 'pending') {
                suppressAI = true;
              } else if (st?.state === 'sent') {
                await run(
                  `UPDATE firstmsg_state SET state='done', done_ts=? WHERE tenant_id=? AND acc_id=? AND jid=?`,
                  [nowSec(), tenantId, accId, jid]
                );
              }
            }
          } catch(e) {
            console.warn('[FIRST MESSAGE TEMPLATE][TG] error:', e?.message || e);
          }

          // --- [MEDIA TRIGGERS] TG: если входящее подходит под правило — отправляем медиа и гасим AI
          if (!suppressAI) {
            try {
              const triggers = await loadMediaTriggers(tenantId);
              if (triggers.length) {
                const hit = triggers.find(tr => tr.media_file && mediaTriggerMatches(tr, (userText || '')));
                if (hit) {
                  await tgSendMediaFromUploads(token, chatId, hit.media_kind, hit.media_file, hit.caption || '');

                  if (hit.also_reply_text && hit.also_reply_text.trim()) {
                    await sleep(200);
                    await tgSendLongText(token, chatId, hit.also_reply_text.trim());
                  }

                  const tsOut = nowSec();
                  const dateOut = new Date(tsOut * 1000).toISOString().slice(0, 10);
                  const extId = crypto.randomUUID();

                  await run(
                    `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
                    VALUES(?,?,?,?,?,?,?,?,?,?)`,
                    [tenantId, jid, dateOut, tsOut,
                      (hit.also_reply_text || hit.caption || '').trim() || (hit.media_kind === 'image' ? '🖼 Изображение' : '🎬 Видео'),
                      'out', accId, hit.media_file, hit.media_kind, extId]
                  );

                  await pushMessageToCRM({
                    tenant_id: tenantId,
                    acc_id: accId,
                    jid,
                    direction: 'out',
                    text: (hit.also_reply_text || hit.caption || '').trim(),
                    media_file: hit.media_file,
                    media_kind: hit.media_kind,
                    external_id: extId
                  });

                  suppressAI = true;
                }
              }
            } catch (e) {
              console.warn('[TG][MEDIA TRIGGERS] error:', e?.message || e);
            }
          }

          if (!suppressAI) {
            if (await isBlocked(accId, jid)) continue;

            const k = _rk(accId, jid);
            replyInputKinds.set(k, inboundKind);
            await scheduleAIReply(accId, jid, false);
          }
        }

        // сохраняем offset, чтобы после рестарта не ловить дубли
        await run(`UPDATE accounts SET tg_offset=?, updated_at=? WHERE id=?`, [rec.offset, Date.now(), accId]);
      }
    } finally {
      tgBots.delete(accId);
      try { await setAccStatus(accId, 'offline', null); } catch(_){}
    }
  })();
}

async function stopTelegramAccount(accId){
  const rec = tgBots.get(accId);
  if (rec) rec.stopping = true;
  // статус поставит finally в loop, но на всякий:
  try { await setAccStatus(accId, 'offline', null); } catch(_){}
}

// -------------------------------------------------
// WhatsApp lifecycle
// -------------------------------------------------
async function startAccount(accId){
  
  if (startingAccounts.has(accId)) return;
  startingAccounts.add(accId);

  try {

  if (sockets.get(accId)?.sock) return;
  const acc = await get(`SELECT * FROM accounts WHERE id=?`, [accId]);
  if (!acc) throw new Error('account not found');
  const tenantId = Number(acc.tenant_id||1);

  const kind = String(acc.kind || 'wa').toLowerCase();
  if (kind === 'tg' || kind === 'telegram') {
    await startTelegramAccount(accId);
    return;
  }

  // ⭐ WABA: не запускать Baileys!
  if (acc.waba_enabled === 1) {
    const prov = String(acc.waba_provider || 'meta');

    console.log(`[WABA] Account ${accId} is WABA(${prov}) - skipping Baileys`);

    if (prov === 'meta') {
      if (!acc.waba_phone_number_id || !acc.waba_access_token) {
        console.error(`[WABA] Account ${accId} missing meta credentials`);
        await setAccStatus(accId, 'qr');
        startingAccounts.delete(accId);
        return;
      }
      await setAccStatus(accId, 'online', null);
      console.log(`✅ [WABA] Account ${accId} is online (Meta Cloud API)`);
      startingAccounts.delete(accId);
      return;
    }

    if (prov === 'gupshup') {
      if (!acc.gupshup_app_id || !acc.gupshup_app_token) {
        console.error(`[WABA] Account ${accId} missing gupshup app_id/app_token`);
        await setAccStatus(accId, 'need_login');
        startingAccounts.delete(accId);
        return;
      }
      await setAccStatus(accId, 'online', null);
      console.log(`✅ [WABA] Account ${accId} is online (Gupshup)`);
      startingAccounts.delete(accId);
      return;
    }

    await setAccStatus(accId, 'qr');
    startingAccounts.delete(accId);
    return;
  }

  const { version } = await fetchLatestBaileysVersion();
  console.log('Using WA Web version', version)


  const folder = path.join('auth', `acc-${accId}`);

  await fsp.mkdir(folder, { recursive: true });

  // фиксируем folder + принудительно ставим wa_engine='baileys'
  if (!acc.folder || String(acc.folder).trim() !== folder || String(acc.wa_engine || '').toLowerCase() !== 'baileys') {
    await run(`UPDATE accounts SET folder=?, wa_engine='baileys', updated_at=? WHERE id=?`, [folder, Date.now(), accId]);
    acc.folder = folder;
    acc.wa_engine = 'baileys';
  }


  const { state, saveCreds } = await useMultiFileAuthState(folder);

    let msgRetryCounterMap = {};
    try {
      const retryPath = path.join(folder, 'msg-retry-counter.json');
      const retryData = await fsp.readFile(retryPath, 'utf8');
      msgRetryCounterMap = JSON.parse(retryData);
      console.log(`[WA][ACC#${accId}] Loaded ${Object.keys(msgRetryCounterMap).length} retry counters`);
    } catch (e) {
      msgRetryCounterMap = {};
    }
    
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: process.env.WA_LOG_LEVEL || 'fatal' }).child({ accId }),
      // syncFullHistory: true,
      syncFullHistory: false,           // ⭐ КРИТИЧНО: не грузим всю историю
      fireInitQueries: true,              // ⭐ ДОБАВЬ ЭТУ СТРОКУ
      shouldSyncHistoryMessage: msg => false, // ⭐ И ЭТУ СТРОКУ
      printQRInTerminal: false,
      connectTimeoutMs: 120_000,        // было 60_000
      retryRequestDelayMs: 5_000,       // было 2_000
      keepAliveIntervalMs: 25_000,      // 25 секунд (рекомендация Baileys)    
      msgRetryCounterMap,
      maxMsgRetryCount: 5,
      defaultQueryTimeoutMs: 60000,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,   // ← не объявляемся «онлайн» при коннекте
      ignoreOldMessages: true,
      emitOwnEvents: false,
      
      getMessage: async (key) => {
        try {
          const remoteJid = key?.remoteJid;
          const id = key?.id;

          // ⭐ DEBUG лог
          console.log(`[WA][getMessage] SEARCH: jid=${remoteJid} id=${id} tenant=${tenantId} acc=${accId}`);
          
          if (!remoteJid || !id) {
            return undefined;
          }
          
          // ⭐ ПОПЫТКА 1: Ищем по wa_id (по любому JID из аккаунта)
          let row = await get(
            `SELECT message, media_kind, media_file
              FROM chats
              WHERE tenant_id=? AND acc_id=? AND wa_id=?
              ORDER BY id DESC
              LIMIT 1`,
            [tenantId, accId, id]
          );

          // ⭐ ПОПЫТКА 2: Если не нашли по wa_id, ищем последнее исходящее за последние 5 секунд
          // Это решает race condition: сообщение уже в базе, но wa_id ещё не обновлён
          if (!row) {
            const now = Math.floor(Date.now() / 1000);
            row = await get(
              `SELECT message, media_kind, media_file
                FROM chats
                WHERE tenant_id=? AND acc_id=? AND type='out'
                  AND ts >= ?
                ORDER BY id DESC
                LIMIT 1`,
              [tenantId, accId, now - 5]
            );
            
            if (row) {
              console.log(`[WA][getMessage] Found by timestamp: ${id.slice(0, 10)}...`);
            }
          }

          if (!row) {
            console.log(`[WA][getMessage] Not found in DB: ${id.slice(0, 10)}...`);
            return undefined;
          }

          const text = String(row.message || '').trim();
          
          // Если есть медиа - формируем правильный объект
          if (row.media_kind && row.media_file) {
            const mediaType = row.media_kind;
            
            if (mediaType === 'image') {
              return {
                imageMessage: {
                  caption: text || undefined
                }
              };
            }
            
            if (mediaType === 'video') {
              return {
                videoMessage: {
                  caption: text || undefined
                }
              };
            }
            
            if (mediaType === 'audio' || mediaType === 'voice') {
              return {
                audioMessage: {}
              };
            }
            
            if (mediaType === 'document') {
              return {
                documentMessage: {
                  caption: text || undefined
                }
              };
            }
          }
          
          // Если текст пустой - возвращаем undefined
          if (!text) {
            return undefined;
          }
          
          // Обычное текстовое сообщение
          return {
            conversation: text
          };

        } catch (e) {
          console.error('[WA][getMessage] ERROR:', e?.message || e);
          return undefined;
        }
      }
    });

  sockets.set(accId, { sock, stopping:false, tenantId, msgRetryCounterMap });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    
    try {
      const retryPath = path.join(folder, 'msg-retry-counter.json');
      await fsp.writeFile(retryPath, JSON.stringify(msgRetryCounterMap, null, 2), 'utf8');
    } catch (e) {
      console.warn('[WA][RETRY_SAVE]', e?.message);
    }
  });

  sock.ev.on('connection.update', async upd=>{
    if (upd.qr) {
      // ВАЖНО: не переводим ONLINE -> QR из-за временных событий реконнекта.
      // QR показываем только когда аккаунт реально не привязан (не registered).
      const registered = !!(state && state.creds && state.creds.registered);

      if (!registered) {
        lastQRMap.set(accId, upd.qr);
        io.to(`tenant_${tenantId}`).emit('acc:qr', { id: accId, qr: upd.qr });
        await setAccStatus(accId, 'qr');
      } else {
        // игнорируем QR, чтобы статус не прыгал
        // (можно оставить лог для диагностики)
        // console.log(`ACC#${accId}: got qr while registered -> ignoring`);
      }
    }

    if (upd.connection==='open'){
      lastQRMap.delete(accId);
      reconnectAttempts.delete(accId);
      const me = state?.creds?.me?.id||null;
      await setAccStatus(accId,'online',me);
          
          // ✅ ДОБАВЬ ЭТО:
          // Закрываем QR попап автоматически
          try {
            const tenantId = (await get(`SELECT tenant_id FROM accounts WHERE id=?`, [accId]))?.tenant_id;
            if (tenantId) {
              io.to(`tenant_${tenantId}`).emit('acc:qr', {id: accId, qr: null});
              console.log(`[WA] QR popup closed for acc ${accId}`);
            }
          } catch (err) {
            console.error(`[WA] Close QR error:`, err);
          }
          // КОНЕЦ ДОБАВЛЕНИЯ

      io.to(`tenant_${tenantId}`).emit('acc:qr',{id:accId, qr:null});
      console.log(`✅ ACC#${accId} connected successfully.`);
      
      // ⭐ ИСПРАВЛЕНО: Периодический presence update
      const presenceInterval = setInterval(async () => {
        const currentSock = sockets.get(accId);
        if (!currentSock || currentSock.stopping) {
          clearInterval(presenceInterval);
          return;
        }
        try {
          await sock.sendPresenceUpdate('available');
        } catch (e) {
          console.warn(`[ACC#${accId}] Presence failed:`, e.message);
          clearInterval(presenceInterval);
        }
      }, 60000);
      
      // ✅ ИСПРАВЛЕНО: Определяем rec ДО использования!
      const rec = sockets.get(accId);
      if (!rec) {
        sockets.set(accId, { sock, stopping: false, presenceInterval });
      } else {
        rec.presenceInterval = presenceInterval;
      }
      
      try { await sock.sendPresenceUpdate('available'); } catch(_) {}
    }
    
    if (upd.connection === 'close') {
      const rec = sockets.get(accId);
      const stopping = rec?.stopping;

      const code = upd?.lastDisconnect?.error?.output?.statusCode;

        // ⭐ НОВОЕ: Обработка restartRequired (WhatsApp изменил версию)
        if (code === DisconnectReason.restartRequired) {
          console.log(`🔄 ACC#${accId} restart required - WhatsApp changed version. Restarting...`);

          // ⭐ НОВОЕ: Очистка presence interval
          const rec = sockets.get(accId);
          if (rec?.presenceInterval) {
            clearInterval(rec.presenceInterval);
          }
          sockets.delete(accId);

          setTimeout(() => {
            startAccount(accId).catch(e => console.error(`[ACC#${accId}] Restart failed:`, e?.message));
          }, 2000);
          return;
        }

      // если аккаунт реально разлогинили/отвязали — не крутим бесконечный реконнект
      if (code === DisconnectReason.loggedOut || code === 401) {
        console.warn(`⚠️ ACC#${accId} logged out/unlinked. Pausing until user reconnects.`);
        try { await logoutAccount(accId); } catch(e) { console.error('logout cleanup fail', e?.message || e); }
        return;
      }

      const loggedOut =
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.badSession ||
        code === 401;

      sockets.delete(accId);

      // ✅ Если аккаунт ОТВЯЗАЛИ/вышел — НЕ реконнектим, просто ждём нового подключения
      if (loggedOut) {
        console.error(`🚫 ACC#${accId} logged out/unlinked. Pausing all processes until re-link.`);
        await setAccStatus(accId, 'qr'); // чтобы в панели было видно "нужно подключить"
        return;
      }

      // обычное падение — реконнектим с exponential backoff
      await setAccStatus(accId, 'offline');

      if (!stopping) {
        let attempts = reconnectAttempts.get(accId) || { count: 0, lastAttempt: 0 };
        attempts.count++;
        attempts.lastAttempt = Date.now();
        reconnectAttempts.set(accId, attempts);

        if (attempts.count > MAX_RECONNECT_ATTEMPTS) {
          console.warn(`⚠️ ACC#${accId} exceeded ${MAX_RECONNECT_ATTEMPTS} attempts. Resetting.`);
          attempts.count = 1;
          reconnectAttempts.set(accId, attempts);
        }

        const exponentialDelay = Math.min(
          BASE_RECONNECT_DELAY * Math.pow(2, attempts.count - 1),
          MAX_RECONNECT_DELAY
        );
        const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
        const finalDelay = Math.max(1000, exponentialDelay + jitter);

        console.error(`❌ ACC#${accId} closed. Attempt #${attempts.count}. Reconnect in ${(finalDelay/1000).toFixed(1)}s`);
        
        setTimeout(() => {
          startAccount(accId).catch(e => console.error(`[ACC#${accId}] Reconnect failed:`, e?.message));
        }, finalDelay);
      } else {
        reconnectAttempts.delete(accId);
      }
    }
  });

  sock.ev.on('messages.upsert', async m=>{
    try{
      const msg = m.messages?.[0]; if(!msg) return;

    // Обрабатываем только реальные уведомления о новых сообщениях (иначе прилетают append/sync и т.п.)
    if (m?.type && m.type !== 'notify') return;
    // Иногда Baileys присылает апдейт без msg.message (пустой) — не сохраняем как unknown
    if (!msg.message) return;

      // DEBUG: лог каждого входящего/исходящего события из WA
      if (process.env.WA_DEBUG === '1') {
        console.log('[WA][UPSET]', {
          accId,
          jid: msg.key?.remoteJid,
          senderPn: msg.key?.senderPn,
          fromMe: !!msg.key?.fromMe,
          hasMessage: !!msg.message,
          messageType: msg.message && Object.keys(msg.message)[0]
        });
      }

    // Сначала узнаём JID собеседника
    const myJid = normalizeMeJid(sock?.user?.id || sock?.user?.jid || '');
    let jid = String(msg.key?.remoteJid || '');

    // 1) Если Baileys вдруг дал remoteJid = МОЙ jid, а реальный собеседник в participant — берём participant
    try {
      const remote = String(msg.key?.remoteJid || '');
      const participant = String(msg.key?.participant || msg.participant || '');
      if (myJid && remote === myJid && participant) {
        jid = participant;
      }
    } catch(_) {}

    // 2) LID-safe: НЕ подменяем jid. WhatsApp может прислать @lid (новый формат).
    //    Пытаемся только безопасно определить реальный телефон (если WA его реально отдаёт),
    //    и сохраняем mapping lid -> phone. Если телефона нет (privacy), будет "WhatsApp User".
    try {
      const originalRemote = normalizeDirectJid(String(msg.key?.remoteJid || ''));
      if (originalRemote && originalRemote.endsWith('@lid')) {

        const candidates = [];

        // #1: Иногда @lid содержит сам номер (например 7XXXXXXXXXX@lid)
        const lidDigits = originalRemote.replace(/@lid$/,'').replace(/\D+/g,'');
        if (looksLikePhoneDigits(lidDigits)) candidates.push(lidDigits);

        // #2: senderPn иногда содержит реальный phone_jid, но иногда это мусор → обязательно проверяем
        const senderPnJid = normalizeDirectJid(String(msg.key?.senderPn || ''));
        const senderDigits = jidToPhone(senderPnJid);
        if (looksLikePhoneDigits(senderDigits)) candidates.push(senderDigits);

        // #3: participant (на всякий случай)
        const partJid = normalizeDirectJid(String(msg.key?.participant || msg.participant || ''));
        const partDigits = jidToPhone(partJid);
        if (looksLikePhoneDigits(partDigits)) candidates.push(partDigits);

        let verifiedDigits = '';
        for (const d of candidates) {
          if (await isPhoneOnWhatsApp(sock, d)) { verifiedDigits = d; break; }
        }

        if (verifiedDigits) {
          const phoneJid = verifiedDigits + '@s.whatsapp.net';

          await run(
            `INSERT OR REPLACE INTO lid_mapping(acc_id, lid, phone_jid, phone_number, is_verified, updated_at)
             VALUES(?,?,?,?,?,?)`,
            [accId, originalRemote, phoneJid, verifiedDigits, 1, nowSec()]
          );

          // Если профиль был заглушкой — заменим на номер (чтобы UI показывал номер в списке чатов)
          try{
            const prof = await getProfile(accId, originalRemote);
            const nm = String(prof?.name || '').trim();
            if (!nm || /^whatsapp user$/i.test(nm) || nm === originalRemote.replace(/@.*/,'')) {
              await saveProfile(accId, originalRemote, { name: verifiedDigits });
            }
          }catch(_){}
        }
      }
    } catch(e) {
      console.warn('[LID→PHONE] failed:', e?.message || e);
    }



    if (!jid) return;

    jid = normalizeDirectJid(jid);
    if (!jid) return;

    // если по какой-то причине jid получился нашим же номером — это self/эхо, не создаём отдельный чат
    if (myJid && jid === myJid) return;

    // считаем прямым диалогом всё, что НЕ группа/бродкаст/статус/канал
    const isGroup      = jid.endsWith('@g.us');
    const isBroadcast  = jid.endsWith('@broadcast');
    const isStatus     = jid === 'status@broadcast';
    const isNewsletter = jid.endsWith('@newsletter');

    const isDirect = !isGroup && !isBroadcast && !isStatus && !isNewsletter;
    if (!isDirect) return;

      // Потом уже собираем имя из pushName/контакта
      const waPush = msg?.pushName || msg?.participant?.pushName || '';
      const contact = (sockets.get(accId)?.sock?.store?.contacts?.[jid]) || {};
      const contactName = contact?.name || contact?.verifiedName || contact?.notify || '';
      const waDisplayName = (waPush?.trim() || contactName?.trim() || jid.replace(/@.*/, '') || 'WhatsApp User').slice(0, 80);

      // сохранить человекочитаемое имя из WhatsApp в профиль
      try {
        const prof = await getProfile(accId, jid);
        const looksLikePhone = /^\+?\d{7,}$/.test(String(prof?.name||'').replace(/\s+/g,''));
        const isBareJid = (prof?.name||'') === jid.replace(/@.*/,'');
        if (!prof?.name || looksLikePhone || isBareJid) {
          await saveProfile(accId, jid, { name: waDisplayName });
        }
      } catch(_){}

      const tenantId = await getAccTenant(accId);

      if (false) {
      // --- MIGRATE legacy jid: digits@s.whatsapp.net -> digits@lid (если WA реально прислал @lid) ---
      try {
        const rawRemote = String(msg.key?.remoteJid || '').replace(/^(\d+):/, '');
        if (rawRemote.endsWith('@lid')) {
          const digits = rawRemote.replace(/@.*/, '').replace(/\D+/g, '');
          const legacy = digits ? (digits + '@s.whatsapp.net') : '';
          if (legacy && legacy !== rawRemote) {
            await run(`UPDATE profiles SET jid=? WHERE acc_id=? AND jid=?`, [rawRemote, accId, legacy]);
            await run(`UPDATE chats    SET jid=? WHERE tenant_id=? AND acc_id=? AND jid=?`, [rawRemote, tenantId, accId, legacy]);
            // blocks у тебя хранит jid с префиксом accId:
            await run(`UPDATE blocks   SET jid=? WHERE tenant_id=? AND jid=?`, [`${accId}:${rawRemote}`, tenantId, `${accId}:${legacy}`]);
          }
        }
      } catch(e) {
        console.warn('[JID_MIGRATE] failed:', e?.message || e);
        }
      }

      const message = unwrapWAMessage(msg.message||{});

      // Если после unwrap всё равно пусто — это не сообщение, а служебный апдейт. Пропускаем.
      if (!message || Object.keys(message).length === 0) return;

      // WA message id (используем для дедупликации)
      const waId = String(
        msg?.key?.id ||
        message?.extendedTextMessage?.contextInfo?.stanzaId ||
        ''
      ).trim();

      // РАННИЙ анти-дубль: если такой входящий уже есть — выходим до любой тяжёлой обработки
      if (waId) {
        const dupIn = await get(
          `SELECT id FROM chats
          WHERE tenant_id=? AND acc_id=? AND jid=? AND wa_id=?`,
          [tenantId, accId, jid, waId]
        );
        if (dupIn) {
          console.log(`[WA][DUPLICATE] Skipping duplicate message ${waId.slice(0,10)}... for ${jid}`);
          return;
        }
      }

      // ДОПОЛНИТЕЛЬНО: проверка по тексту + временному окну (если waId пустой)
      if (!waId && userText) {
        const recentDup = await get(
          `SELECT id FROM chats
          WHERE tenant_id=? AND acc_id=? AND jid=? AND message=? AND type='in'
            AND ts >= ?
          ORDER BY id DESC LIMIT 1`,
          [tenantId, accId, jid, userText, nowSec() - 10]  // последние 10 секунд
        );
        if (recentDup) {
          console.log(`[WA][DUPLICATE] Skipping duplicate by text for ${jid}`);
          return;
        }
      }

      const rawText = message.conversation || message.extendedTextMessage?.text || '';
      let txt = (rawText||'').trim();

      const fromMe   = !!msg.key.fromMe;
      const stopword = (await getSetting('stopword', tenantId)||'стоп').trim().toLowerCase();
      const startword= (await getSetting('startword', tenantId)||'включить').trim().toLowerCase();
      const blockMin = parseInt(await getSetting('block_time_min', tenantId)||'60',10);

      // 1) Сообщения от менеджера (или эхо наших отправок)
      if (fromMe) {
        cancelAIReply(accId, jid);

        const tsNow = nowSec();

        const low = String(txt || '')
          .trim()
          .toLowerCase()
          .replace(/^[\/!#]+\s*/,'')
          .trim();

        // анти-дубликат: такой же исходящий от нас за последние 30 секунд?
        const dup = await get(
          `SELECT id FROM chats
          WHERE tenant_id=? AND acc_id=? AND jid=? AND type='out' AND message=?
            AND ts >= ? ORDER BY id DESC LIMIT 1`,
          [tenantId, accId, jid, txt, tsNow - 30]
        );
        if (dup) {
          // это эхо того, что мы уже сами записали (AI/ручная отправка из панели)
          // НО стоп/старт всё равно должны работать, даже если запись уже есть в базе.
          if (low === stopword || low.startsWith(stopword + ' ')) {
            await setBlock(accId, jid, blockMin);
            await escalate(accId, jid, 'human_needed', 'Оператор взял диалог. AI OFF');
            return;
          }
          if (low === startword || low.startsWith(startword + ' ')) {
            await setBlock(accId, jid, 0);
            return;
          }
          return;
        }

        const ts = tsNow;
        const date = new Date(ts*1000).toISOString().slice(0,10);
        const extId = crypto.randomUUID();

        // --- Универсальное обновление языка профиля (после сборки userText) ---
        try {
          const { forced_lang } = await getAccLLMConfig(accId);
          const lang_auto = (await getSetting('lang_auto', tenantId)) === '1';
          if (lang_auto && !forced_lang) {
            // убираем служебные префиксы типа "🎤 Расшифровка: "
            const sample = String(txt || '').replace(/^🎤\s*Расшифровка:\s*/i, '').trim();
            const detected = detectLangHeuristic(sample);
            const profNow = await getProfile(accId, jid);
            if (detected && detected !== (profNow.lang || '')) {
              await saveProfile(accId, jid, { lang: detected });
            }
          }
        } catch (_) {}

        await run(
          `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,crm_ext_id)
          VALUES(?,?,?,?,?,?,?,?)`,
          [tenantId, jid, date, ts, txt, 'out', accId, extId]
        );

        if (low === stopword || low.startsWith(stopword + ' ')) {
          await setBlock(accId, jid, blockMin);
          await escalate(accId, jid, 'human_needed', 'Оператор взял диалог. AI OFF');
          return;
        }
        if (low === startword || low.startsWith(startword + ' ')) {
          await setBlock(accId, jid, 0);
          return;
        }

        await evaluateAndUpdateStage(accId, jid);

        // пушим в CRM только если это НЕ дубликат (мы его уже пушили выше)
        await pushMessageToCRM({
          tenant_id: tenantId,
          acc_id: accId,
          jid,
          direction: 'out',
          text: txt || '',
          media_file: '',
          media_kind: '',
          external_id: extId
        });
        return;
      }

      // 2) Сообщения от клиента
      const lists = await getPhraseLists(tenantId);
      const { blacklist, badwords } = lists;
      const white = lists.whitelist;

      if (includesPhrase(txt, blacklist)){ await escalate(accId,jid,'blacklist_trigger',txt); }
      if ((await getSetting('moderation_enabled', tenantId))==='1' && includesPhrase(txt, badwords)){ await escalate(accId,jid,'moderation_badword',txt); return; }
      if (includesPhrase(txt, ['оператор','менеджер','человек','позвоните','свяжитесь','дозвон'])){ await escalate(accId,jid,'human_needed',txt); return; }

      const profile = await getProfile(accId, jid);
      let lang = profile?.lang || '';
      const { forced_lang } = await getAccLLMConfig(accId);
      const lang_auto = (await getSetting('lang_auto', tenantId))==='1';

      if (!forced_lang && lang_auto) {
        const detected = detectLangHeuristic(txt);
        if (detected && detected !== lang) {
          lang = detected;
          await saveProfile(accId, jid, { lang });
        }
      }
      let suppressAI = false; // если true — в конце не вызывать scheduleAIReply

      // --- распарсить сообщение/фото/видео/аудио ---
      let userText = '';
      let media_file = '';
      let media_kind = ''; // 'image' | 'video'
      const openaiKey = await getOpenAIKeyForTenant(tenantId);

      // Включено ли распознавание чеков по PDF (галочка в настройках)
      const receiptOcrEnabled =
        (await getSetting('receipt_ocr_enabled', tenantId)) === '1';

      // text
      if (message.conversation) {
        userText = message.conversation.trim();
      } else if (message.extendedTextMessage?.text) {
        userText = message.extendedTextMessage.text.trim();
      }

      // image
      else if (message.imageMessage) {
        const node   = message.imageMessage;
        const stream = await downloadContentFromMessage(node, 'image');
        const fname  = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
        const abs    = path.join(UPLOAD_DIR, fname);
        const ws     = fs.createWriteStream(abs);
        await streamPipeline(stream, ws);
        media_file = 'uploads/' + fname;
        media_kind = 'image';
        const caption = (node.caption||'').trim();

        // OCR + краткое описание через gpt-4o-mini (vision)
        try{
          if(openaiKey){
            const openai = new OpenAI({ apiKey: openaiKey });
            const dataURL = await fileToDataURL(abs, 'image/jpeg');
            const comp = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 220,
              messages: [{
                role:'user',
                content: [
                  { type: 'text', text: 'Извлеки весь читаемый текст (OCR) и кратко опиши, что на фото. Верни короткий абзац.' },
                  { type: 'image_url', image_url: { url: dataURL } }
                ]
              }]
            });
            const rawVision = (comp.choices?.[0]?.message?.content||'').trim();
            const vision = sanitizeVisionText(rawVision);
            userText = ['[Фото]', caption, vision].filter(Boolean).join('\n');
          } else {
            userText = ['[Фото]', caption].filter(Boolean).join('\n');
          }
        }catch(_){
          userText = ['[Фото]', caption].filter(Boolean).join('\n');
        }
      }

      // video
      else if (message.videoMessage) {
        const node   = message.videoMessage;
        const stream = await downloadContentFromMessage(node, 'video');
        const fname  = `${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
        const abs    = path.join(UPLOAD_DIR, fname);
        const ws     = fs.createWriteStream(abs);
        await streamPipeline(stream, ws);
        media_file = 'uploads/' + fname;
        const isGif = !!node.gifPlayback;
        const isPtv = !!node.ptv;
        media_kind = isGif ? 'gif' : (isPtv ? 'ptv' : 'video');
        const caption = (node.caption||'').trim();

        const parts = [isGif ? '[GIF]' : (isPtv ? '[Видео-кружок]' : '[Видео]')];
        if (caption) parts.push(caption);

        // транскрипция речи (устойчивый fallback)
        try {
          if (openaiKey && !isGif) {
            console.time('[ASR][video]');
            const speech = await transcribeWithFallback(abs, openaiKey);
            console.timeEnd('[ASR][video]');
            if (speech) parts.push('Речь: ' + speech);
          }
        } catch(e) {
          console.warn('[ASR][video] error:', e?.message || e);
        }

        // описание по превью-кадру
        try{
          if(openaiKey && !isGif && node?.jpegThumbnail){
            const openai = new OpenAI({ apiKey: openaiKey });
            const dataURL = `data:image/jpeg;base64,${Buffer.from(node.jpegThumbnail).toString('base64')}`;
            const comp = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              temperature: 0.2,
              max_tokens: 160,
              messages: [{
                role:'user',
                content: [
                  { type:'text', text:'Кратко опиши сцену/людей/предметы на превью видео (1–2 предложения).' },
                  { type:'image_url', image_url:{ url: dataURL } }
                ]
              }]
            });
            const rawPrev = (comp.choices?.[0]?.message?.content||'').trim();
            const prev = sanitizeVisionText(rawPrev);
            if (prev) parts.push('Кадр: ' + prev);

          }
        }catch(_){}

        userText = parts.join('\n');
      }

      // pdf чек (documentMessage или documentWithCaptionMessage)
      else if (
        message.documentMessage ||
        (message.documentWithCaptionMessage &&
        message.documentWithCaptionMessage.message &&
        message.documentWithCaptionMessage.message.documentMessage)
      ) {
        const node =
          message.documentMessage ||
          message.documentWithCaptionMessage.message.documentMessage;

        const isPdf =
          /pdf/i.test(node.mimetype || '') ||
          /\.pdf$/i.test(node.fileName || node.caption || '');

        // если это действительно PDF — обрабатываем чек только если включено в настройках
        if (isPdf) {
          try {
            console.log('📄 PDF incoming:', {
              mimetype: node.mimetype,
              fileName: node.fileName,
              caption: node.caption
            });

            const stream = await downloadContentFromMessage(node, 'document');
            const fname  = `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
            const abs    = path.join(UPLOAD_DIR, fname);
            const ws     = fs.createWriteStream(abs);
            await streamPipeline(stream, ws);

            media_file = 'uploads/' + fname;
            media_kind = 'pdf';

            // 1) пробуем вытащить текст напрямую
            let pdfText = '';
            try {
              const buf    = await fsp.readFile(abs);
              const parsed = await pdfParse(buf);
              pdfText      = String(parsed?.text || '').trim();
            } catch (e) {
              console.error('pdf-parse error:', e.message);
            }

            // 2) если текста мало — OCR по 1-й странице через vision
            if (!pdfText || pdfText.replace(/\s+/g, '').length < 20) {
              try {
                const png = await pdfFirstPageToPng(abs);
                if (png && openaiKey) {
                  const openai  = new OpenAI({ apiKey: openaiKey });
                  const dataURL = await fileToDataURL(png, 'image/png');
                  const comp = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    temperature: 0,
                    max_tokens: 500,
                    messages: [{
                      role: 'user',
                      content: [
                        { type: 'text', text: 'Это скан чека/квитанции. Извлеки ключевые поля: дата, отправитель/получатель, назначение/комментарий, номер/ID операции, сумма с валютой. Дай краткий связный текст (не JSON).' },
                        { type: 'image_url', image_url: { url: dataURL } }
                      ]
                    }]
                  });
                  const visionTxt = (comp.choices?.[0]?.message?.content || '').trim();
                  if (visionTxt) pdfText = visionTxt;
                }
              } catch (err) {
                console.error('PDF OCR fallback error:', err?.message || err);
              }
            }

            // 3) если включён режим чеков — парсим сумму и отвечаем как по чеку,
            //    иначе просто передаём текст PDF в ИИ как обычное сообщение
            if (receiptOcrEnabled) {
              let parsedSum = parseReceiptAmount(pdfText);

              // План Б: если регэкспы не нашли — спросим LLM
              if (!parsedSum && openaiKey) {
                parsedSum = await tryLLMAmount(openaiKey, pdfText);
              }

              if (parsedSum) {
                await confirmReceipt(accId, jid, media_file, pdfText, parsedSum);
                userText = `[Чек PDF]\nАвтоматически распознано: ${
                  Number(parsedSum.amount).toFixed(2)
                }${parsedSum.currency ? (' ' + parsedSum.currency) : ''}`;
              } else {
                await sock.sendMessage(jid, {
                  text: '📄 Түбіртек алынды, рақмет! Тексеріп жатырмыз…'
                });
                // В журнал входящего пишем без отрицательной формулировки
                userText = '[Түбіртек PDF] Тексеріске алынды.';
              }
              // мы сами ответили по PDF — не планируем AI-ответ
              suppressAI = true;
            } else {
              // Режим чеков выключен: используем PDF как обычный текст для ИИ
              const maxChars = 4000; // чтобы не улететь в слишком длинный промпт
              const safeText = (pdfText || '').trim().slice(0, maxChars);
              const title = (node.fileName || node.caption || '').trim();

              userText =
                (title ? `[PDF] ${title}\n\n` : '[PDF]\n\n') +
                (safeText || '[Текст PDF распознать не удалось]');

              // Здесь чек НЕ считаем и suppressAI специально НЕ трогаем —
              // дальше по коду пойдёт обычный AI-ответ на userText.
            }
            } catch (e) {
              console.error('PDF processing error:', e && (e.stack || e.message || e));
            }
          }         else {
          try {
            const stream = await downloadContentFromMessage(node, 'document');

            const origName = (node.fileName || node.caption || '').trim();
            const ext0 = path.extname(origName || '');
            const safeExt = (ext0 && ext0.length <= 8) ? ext0 : '.bin';

            const fname  = `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`;
            const abs    = path.join(UPLOAD_DIR, fname);
            const ws     = fs.createWriteStream(abs);
            await streamPipeline(stream, ws);

            media_file = 'uploads/' + fname;
            media_kind = 'file';

            const txt = await extractOfficeText(abs, origName || fname);
            const safeText = String(txt || '').trim().slice(0, 4000);

            if (safeText) {
              userText = (origName ? `[FILE] ${origName}\n\n` : '[FILE]\n\n') + safeText;
              // suppressAI НЕ трогаем → дальше пойдёт обычный AI-ответ
            } else {
              suppressAI = true;
              await sock.sendMessage(jid, { text: '⚠️ Не удалось извлечь текст из документа. Отправьте PDF или текстом, пожалуйста.' });
              userText = (origName ? `[FILE] ${origName}` : '[FILE]');
            }
          } catch (e) {
            console.error('[WA][DOC] error:', e?.message || e);
          }
        }
        }
      
        // audio / voice
        else if (message.audioMessage || message.voiceMessage) {
        console.log('[WA][IN][AUDIO] from', jid);
        const node   = message.audioMessage || message.voiceMessage;
        const stream = await downloadContentFromMessage(node,'audio');

        // Сохраняем как .ogg (WA voice обычно уже opus/ogg)
        const base   = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const absOgg = path.join(UPLOAD_DIR, `${base}.ogg`);
        const ws     = fs.createWriteStream(absOgg);
        await streamPipeline(stream, ws);

        // Превью для CRM/UI (без падений)
        const absM4A = await safeMakePreviewM4A(absOgg);
        media_file = 'uploads/' + path.basename(absM4A);
        media_kind = 'audio';

        const openaiKey = await getOpenAIKeyForTenant(tenantId);
        if (!openaiKey) {
        userText = '[Голосовое] Принято.';
        suppressAI = true;
        } else {
          try {
            console.time('[ASR][audio]');
            const speech = await transcribeWithFallback(absOgg, openaiKey);
            console.timeEnd('[ASR][audio]');
            if (speech) {
              userText = `🎤 Расшифровка: ${speech}`;
            } else {
              userText = '[Голосовое]';
              // важное: если речи не получилось — не запускаем scheduleAIReply
              suppressAI = true;
            }
          } catch (e) {
            console.warn('[ASR][audio] error:', e?.message || e);
            userText = '[Голосовое]';
            suppressAI = true;
          }
        }
      }

      // sticker
      else if (message.stickerMessage) {
        suppressAI = true;
        media_kind = 'sticker';
        userText = '🧩 Стикер';
        try {
          const stream = await downloadContentFromMessage(message.stickerMessage, 'sticker');
          const base = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const abs = path.join(UPLOAD_DIR, `${base}.webp`);
          const ws = fs.createWriteStream(abs);
          await streamPipeline(stream, ws);
          media_file = 'uploads/' + path.basename(abs);
        } catch (e) {
          console.warn('[WA][STICKER] download error:', e?.message || e);
        }
      }
      // контакты
      else if (message.contactMessage || message.contactsArrayMessage) {
        suppressAI = true;
        media_kind = 'contact';
        const c1 = message.contactMessage;
        const arr = message.contactsArrayMessage?.contacts || [];
        const vcard = String(c1?.vcard || (arr[0]?.vcard || '') || '');
        const name = String(c1?.displayName || arr[0]?.displayName || '').trim();
        const tels = [...vcard.matchAll(/TEL[^:]*:([^\n\r]+)/gi)].map(m => String(m[1]).trim()).filter(Boolean);
        const telText = tels.length ? (' ' + [...new Set(tels)].join(', ')) : '';
        userText = `👤 Контакт: ${name || 'без имени'}${telText}`;
      }
      // локация
      else if (message.locationMessage || message.liveLocationMessage) {
        suppressAI = true;
        media_kind = 'location';
        const loc = message.locationMessage || message.liveLocationMessage;
        const lat = loc?.degreesLatitude;
        const lng = loc?.degreesLongitude;
        if (lat != null && lng != null) {
          userText = `📍 Локация: ${lat}, ${lng} https://maps.google.com/?q=${lat},${lng}`;
        } else {
          userText = '📍 Локация';
        }
      }
      // реакция / системные / интерактивное
      else if (message.reactionMessage) {
        suppressAI = true;

        const emoji = String(message.reactionMessage?.text || '').trim();
        const targetWaId = String(
          message.reactionMessage?.key?.id ||
          message.reactionMessage?.key?.stanzaId ||
          ''
        ).trim();

        // Stable msg_ref = raw WA message id (targetWaId)
        if (emoji && targetWaId) {
          const msgRef = targetWaId;
          const next = await upsertReactionAdd(tenantId, accId, jid, msgRef, emoji);

          io.to(`tenant_${tenantId}`).emit('reaction:update', {
            acc_id: accId,
            jid,
            msg_ref: msgRef,
            reactions_json: next
          });
        }

        return; // НЕ вставляем в chats как отдельное сообщение
      }
      else if (message.protocolMessage) {
        suppressAI = true;
        media_kind = 'system';
        userText = 'ℹ️ Системное сообщение';
      }
      else if (message.buttonsResponseMessage || message.listResponseMessage) {
        suppressAI = true;
        media_kind = 'interactive';
        const b = message.buttonsResponseMessage;
        const l = message.listResponseMessage;
        const txt = String(b?.selectedButtonId || b?.selectedDisplayText || l?.title || l?.singleSelectReply?.selectedRowId || '').trim();
        userText = txt ? `🧾 Выбор: ${txt}` : '🧾 Выбор';
      }
      // иначе
      else {
        suppressAI = true;
        const kind = Object.keys(message || {})[0] || 'unknown';
        media_kind = kind;
        userText = `📩 Сообщение: ${kind}`;
      }

      // --- [MEDIA TRIGGERS] если входящее подходит под правило — отправляем фото/видео и гасим AI
      if (!suppressAI) {
        try {
          const triggers = await loadMediaTriggers(tenantId);
          if (triggers.length) {
            const hit = triggers.find(tr => tr.media_file && mediaTriggerMatches(tr, (txt || userText || '')));
            if (hit) {
              console.log('[MEDIA TRIGGER HIT]', { label: hit.label, jid, text: (txt || userText || '').slice(0,120) });
              // Отправка медиа
              await sendMediaByPath(sock, jid, hit.media_file, hit.media_kind, hit.caption || '');

              // Доп. текст отдельным сообщением (не caption), если указан
              if (hit.also_reply_text && hit.also_reply_text.trim()) {
                await sleep(200);
                await sock.sendMessage(jid, { text: hit.also_reply_text.trim() });
              }

              // Лог в БД + пуш в CRM
              const tsOut = nowSec();
              const dateOut = new Date(tsOut*1000).toISOString().slice(0,10);
              const extId = crypto.randomUUID();

              await run(
                `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
                 VALUES(?,?,?,?,?,?,?,?,?,?)`,
                [tenantId, jid, dateOut, tsOut,
                  (hit.also_reply_text || hit.caption || (hit.media_kind==='image'?'🖼 Изображение':'🎬 Видео')).trim(),
                  'out', accId, hit.media_file, hit.media_kind, extId]
              );

              await pushMessageToCRM({
                tenant_id: tenantId,
                acc_id: accId,
                jid,
                direction: 'out',
                text: (hit.also_reply_text || hit.caption || '').trim(),
                media_file: hit.media_file,
                media_kind: hit.media_kind,
                external_id: extId
              });

              suppressAI = true; // медиа-ответ отправлен — AI не нужен
            }
          }
        } catch (e) {
          console.warn('[MEDIA TRIGGERS] error:', e?.message || e);
        }
      }

      // сброс followups при входящем
      await run(`DELETE FROM followups WHERE tenant_id=? AND acc_id=? AND jid=?`, [tenantId, accId, jid]);

      // гарантируем, что профиль для этого номера существует
      try {
        await getProfile(accId, jid); // getProfile сам создаст запись в profiles, если её ещё нет
      } catch (e) {
        console.warn('getProfile on incoming failed', accId, jid, e?.message || e);
      }

      const ts = nowSec(), date = new Date(ts*1000).toISOString().slice(0,10);
      await run(
        `INSERT OR IGNORE INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,wa_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, jid, date, ts, userText, 'in', accId, media_file, media_kind, waId || null]
      );

      await pushMessageToCRM({
        tenant_id: tenantId,
        acc_id: accId,
        jid,
        direction: 'in',
        text: userText || '',
        media_file,
        media_kind,
        external_id: waId || ''
      });

      // после INSERT входящего сообщения
      await run(
        `UPDATE campaign_targets
          SET reply_ts = COALESCE(reply_ts, ?)
        WHERE tenant_id=? AND jid=? AND status='sent'`,
        [nowSec(), tenantId, jid]
      );

      // io.to(`tenant_${tenantId}`).emit('newchat',{ acc_id: accId, jid, text:userText, date, media_file, media_kind });

            const phoneResolved = await resolvePhoneForAccJid(accId, jid);

      io.to(`tenant_${tenantId}`).emit('newchat',{
        acc_id: accId,
        jid,
        phone: phoneResolved || '',
        type: 'in',
        ts,
        msg_ref: waId || '',
        wa_id: waId || '',
        text: userText,
        date,
        media_file: toPublicMediaPath(media_file),
        media_kind
      });

      // ⭐ PUSH NOTIFICATION для входящих (ВСТАВЬ ЭТО)
      try {
        const subscription = await get(
          `SELECT push_subscription FROM users WHERE tenant_id = ?`,
          [tenantId]
        );
        
        if (subscription && subscription.push_subscription) {
          const webpush = require('web-push');
          
          webpush.setVapidDetails(
            'mailto:support@nedzat.satubooster.kz',
            process.env.VAPID_PUBLIC_KEY || '',
            process.env.VAPID_PRIVATE_KEY || ''
          );
          
          const fromName = await get(
            `SELECT name FROM profiles WHERE acc_id = ? AND jid = ? LIMIT 1`,
            [accId, jid]
          );
          
          const payload = JSON.stringify({
            title: `Сообщение от ${fromName?.name || (phoneResolved || 'WhatsApp User')}`,
            body: userText.substring(0, 100) || 'Медиа',
            icon: '/public/assets/img/logo-gemini-192.png',
            tag: 'new-message',
            url: '/public/chat.html'
          });
          
          await webpush.sendNotification(
            JSON.parse(subscription.push_subscription),
            payload
          ).catch(err => {
            console.warn('[PUSH] Send failed:', err?.message);
          });
        }
      } catch(e) {
        console.warn('[PUSH] Error:', e?.message);
      }

      // извлечение слотов
      const slots_enabled = (await getSetting('slots_enabled', tenantId))==='1';
      if (slots_enabled && openaiKey && userText){
        try{
          const openai = new OpenAI({ apiKey:openaiKey });
          const phoneE164 = phoneResolved ? ('+' + phoneResolved) : '';
          const extract = await openai.chat.completions.create({
            model:'gpt-4o-mini', temperature:0, max_tokens:120,
            messages:[
              {
                role:'system',
                content: [
                  'Извлеки слоты: name, city, budget, interest, phone. Ответь ТОЛЬКО JSON, пустые значения — "".',
                  phoneE164 ? `Поле phone всегда равно "${phoneE164}" (номер уже известен и подтверждён).` : 'Если клиент не оставлял телефон, phone оставь пустым "".',
                  (profile?.name ? 'Если name уже известно, не придумывай новое.' : '')
                ].join(' ')
              },
              {role:'user', content:userText}
            ]
          });
          const js = (extract.choices?.[0]?.message?.content||'').trim();
          try{
            const data = JSON.parse(js);
            const patch={};
            ['name','city','budget','interest'].forEach(k=>{ if(data[k] && !profile[k]) patch[k]=String(data[k]).slice(0,120); });
            if(Object.keys(patch).length) await saveProfile(accId,jid,patch);
          }catch(_){}
        }catch(_){}
      }

      // ---> CRM: пушим лид
      try {
        const profileNow = await getProfile(accId, jid);
          await pushLeadToCRM({
            tenant_id: tenantId,
            acc_id: accId,
            jid,
            phone: phoneResolved || '',
            last_message: userText,
            wa_display_name: waDisplayName
          });
      } catch(_) {}

      // резюме каждые N
      const everyN = parseInt(await getSetting('summary_every_n', tenantId)||'8',10);
      const count  = (await get(`SELECT COUNT(*) c FROM chats WHERE tenant_id=? AND acc_id=? AND jid=?`,[tenantId,accId,jid]))?.c || 0;
      if (openaiKey && everyN>0 && count % everyN === 0){
        try{
          const lastMsgs = await all(`SELECT type,message FROM chats WHERE tenant_id=? AND acc_id=? AND jid=? ORDER BY ts DESC,id DESC LIMIT 14`,[tenantId,accId,jid]);
          const t = lastMsgs.reverse().map(r=> (r.type==='in'?'Клиент: ':'Бот: ')+ (r.message||'')).join('\n');
          const openai = new OpenAI({ apiKey:openaiKey });
          const sum = await openai.chat.completions.create({
            model:'gpt-4o-mini', temperature:0.2, max_tokens:160,
            messages:[{role:'system',content:'Сделай краткое резюме диалога (1–3 предложения) и явные факты. Язык — как у клиента.'},{role:'user',content:t}]
          });
          const summary = (sum.choices?.[0]?.message?.content||'').trim().slice(0,600);
          if(summary) await saveProfile(accId,jid,{summary});
        }catch(_){}
      }

      await evaluateAndUpdateStage(accId, jid);

      // --- [FIRST MESSAGE TEMPLATE] шаблон на первое сообщение, ИИ после ответа клиента ---
      if (!suppressAI) {
        try {
          const fmOn = String(await getSetting('first_message_enabled', tenantId) || '0') === '1';

          // работаем только когда WA дал реальный номер
          if (fmOn && jidToPhone(jid)) {
            const fmText = String(await getSetting('first_message_text', tenantId) || '').trim();
            const fmFile = String(await getSetting('first_message_media_file', tenantId) || '').trim();
            let fmKind = String(await getSetting('first_message_media_kind', tenantId) || '').trim().toLowerCase();
            if (!['image','video','audio','video_note',''].includes(fmKind)) fmKind = '';

            const hasContent = !!(fmText || fmFile);
            if (hasContent) {
              const st = await get(
                `SELECT state FROM firstmsg_state WHERE tenant_id=? AND acc_id=? AND jid=?`,
                [tenantId, accId, jid]
              );

              // 1) если впервые → ставим pending и создаём job → ИИ НЕ отвечает
              if (!st) {
                const delay = Math.max(0, Math.min(600, parseInt(await getSetting('first_message_delay_sec', tenantId) || '0', 10) || 0));
                const nowS = nowSec();

                await run(
                  `INSERT OR IGNORE INTO firstmsg_state(tenant_id, acc_id, jid, state, created_ts)
                  VALUES(?,?,?,?,?)`,
                  [tenantId, accId, jid, 'pending', nowS]
                );

                const haveJob = await get(
                  `SELECT id FROM firstmsg_jobs
                  WHERE tenant_id=? AND acc_id=? AND jid=? AND status='pending'
                  LIMIT 1`,
                  [tenantId, accId, jid]
                );

                if (!haveJob) {
                  await run(
                    `INSERT INTO firstmsg_jobs(tenant_id, acc_id, jid, due_ts, status, text, media_file, media_kind, created_ts)
                    VALUES(?,?,?,?,?,?,?,?,?)`,
                    [tenantId, accId, jid, nowS + delay, 'pending', fmText, fmFile, fmKind, nowS]
                  );
                }

                suppressAI = true;
              }
              // 2) пока шаблон ещё не отправлен → ИИ молчит
              else if (st.state === 'pending') {
                suppressAI = true;
              }
              // 3) шаблон отправлен → первое входящее после него включает ИИ
              else if (st.state === 'sent') {
                await run(
                  `UPDATE firstmsg_state SET state='done', done_ts=? WHERE tenant_id=? AND acc_id=? AND jid=?`,
                  [nowSec(), tenantId, accId, jid]
                );
              }
            }
          }
        } catch (e) {
          console.warn('[FIRST MESSAGE TEMPLATE] error:', e?.message || e);
        }
      }

      // Debounce-ответ (не трогаем, если мы уже сами ответили по PDF/медиа)
      if (!suppressAI) {
        const forceReply = includesPhrase(txt, white);
        if (await isBlocked(accId, jid)) return;
        // запоминаем тип последнего входящего: голос -> голос, текст -> текст
        if (!fromMe) {
          const k = _rk(accId, jid);
          replyInputKinds.set(k, media_kind === 'audio' ? 'voice' : 'text');
        }
        await scheduleAIReply(accId, jid, forceReply);
      }

    }catch(e){ console.error('🔥 handler error', e); }
  });

    // DEBUG: статусы исходящих (дошло ли до WA-сервера / ошибка)
    sock.ev.on('messages.update', (updates) => {
      try {
        for (const u of (updates || [])) {
          if (!u?.key?.fromMe) continue;
          console.log('[WA][MSG_UPDATE]', {
            accId,
            jid: u.key.remoteJid,
            id: u.key.id,
            status: u.update?.status,
            error: u.update?.error
          });
        }
      } catch(_) {}
    });

  } finally {
    startingAccounts.delete(accId);
  }
}



// ⭐ Загрузить msgRetryCounterMap из базы
async function loadMsgRetryCounter(accId) {
  const rows = await all(
    `SELECT msg_id, retry_count FROM wa_msg_retry_counter WHERE acc_id=?`,
    [accId]
  );
  
  const map = {};
  for (const row of rows) {
    map[row.msg_id] = row.retry_count;
  }
  
  return map;
}

// ⭐ Сохранить msgRetryCounterMap в базу
async function saveMsgRetryCounter(accId, msgRetryCounterMap) {
  try {
    for (const [msgId, count] of Object.entries(msgRetryCounterMap)) {
      await run(
        `INSERT INTO wa_msg_retry_counter(acc_id, msg_id, retry_count, updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(acc_id, msg_id) DO UPDATE SET
           retry_count=excluded.retry_count,
           updated_at=excluded.updated_at`,
        [accId, msgId, count, Date.now()]
      );
    }
  } catch (e) {
    console.warn('[WA][RETRY_COUNTER_SAVE]', e?.message);
  }
}

// ⭐ Очистка старых записей (старше 7 дней)
async function cleanOldMsgRetryCounters() {
  const cutoff = Date.now() - (7 * 24 * 3600 * 1000); // 7 дней
  try {
    await run(`DELETE FROM wa_msg_retry_counter WHERE updated_at < ?`, [cutoff]);
  } catch (e) {
    console.warn('[WA][RETRY_COUNTER_CLEAN]', e?.message);
  }
}

// Запускаем очистку раз в день
setInterval(cleanOldMsgRetryCounters, 24 * 3600 * 1000);

async function stopAccount(accId){
  const kind = await getAccKind(accId);
  if (kind === 'tg') {
    await stopTelegramAccount(accId);
    return;
  }
  const rec = sockets.get(accId);
  if (rec?.sock){
    rec.stopping = true;
    try{ 
      rec.sock.ev?.removeAllListeners?.();
      await rec.sock.end?.(true); 
    }catch(_){}
  }
  sockets.delete(accId);
  reconnectAttempts.delete(accId);
  lastQRMap.delete(accId);
  await setAccStatus(accId,'offline');
}

async function logoutAccount(accId){
  const kind = await getAccKind(accId);

  if (kind === 'tg') {
    await stopTelegramAccount(accId);
    tgBots.delete(accId);
    const acc = await get(`SELECT id FROM accounts WHERE id=?`, [accId]);
    if (acc) await setAccStatus(accId,'offline',null);
    return;
  }

  const rec=sockets.get(accId);

  if (rec?.presenceInterval) { try { clearInterval(rec.presenceInterval); } catch(_) {} }

  if(rec?.sock){
    rec.stopping=true;
    try{await rec.sock.logout();}catch(_){}
    try{rec.sock.end?.(true);}catch(_){}
  }
  sockets.delete(accId);
  reconnectAttempts.delete(accId);  // ⭐ НОВОЕ
  lastQRMap.delete(accId);          // ⭐ НОВОЕ
  const acc=await get(`SELECT folder,tenant_id FROM accounts WHERE id=?`,[accId]);
  if(acc?.folder) await rmrf(acc.folder);
  await setAccStatus(accId,'offline',null);
}

// -------------------------------------------------
// Follow-ups
// -------------------------------------------------
async function loadFollowupConfig(tenantId){
  const enabled = (await getSetting('followup_enabled', tenantId)) === '1';
  let steps = []; try{ steps = JSON.parse((await getSetting('followup_steps', tenantId)) || '[]'); }catch(_){}
  steps = Array.isArray(steps)?steps.slice(0,7).map(s=>({
    after_min: parseInt(s.after_min,10)||0,
    text: (s.text||'').toString(),
    media_file: s.media_file?String(s.media_file):'',  
    media_kind: (()=>{
      const mk = String(s.media_kind || '').toLowerCase();
      return ['image','video','audio','video_note'].includes(mk) ? mk : '';
    })(),
    template_id: s.template_id ? parseInt(s.template_id,10) : null,
    ai: !!s.ai,                                   // <── НОВОЕ
    ai_style: (s.ai_style||'').toString()         // <── НОВОЕ
  })).filter(s=> s.after_min>0 && (
    s.ai || s.text.trim() || s.media_file || s.template_id
  )):[];
  steps.sort((a,b)=>(a.after_min||0)-(b.after_min||0));

  // allowed stages for follow-up gate
  let allowed_stages = [];
  try { allowed_stages = JSON.parse((await getSetting('followup_allowed_stages', tenantId)) || '[]'); } catch(_){}
  if (!Array.isArray(allowed_stages)) allowed_stages = [];

  const allowedSet = new Set(['unknown','human_needed','need_identified','booked','not_interested']);
  allowed_stages = allowed_stages
    .map(s=>String(s||'').toLowerCase().trim())
    .filter(s=>allowedSet.has(s));

  if (allowed_stages.length === 0) allowed_stages = ['unknown','human_needed'];
  
  return { enabled, steps, allowed_stages };
}

async function processFollowUps(){
  const accIds = await listAllAccountsIds();
  for(const accId of accIds){
    const tenantId = await getAccTenant(accId);
    const cfg = await loadFollowupConfig(tenantId);

    if(!cfg.enabled || cfg.steps.length===0) continue;

    const accKind = await getAccKind(accId);
    const isWABA = await isWABAAccount(accId);

    // ✅ Baileys требует isAccReady, WABA — нет
    if (accKind !== 'tg' && !isWABA) {
      if (!await isAccReady(accId)) continue;
    }

    let sock = null;
    let tgToken = '';

    if (accKind === 'tg') {
      const recTg = tgBots.get(accId);
      tgToken = recTg?.token || (await get(`SELECT tg_token FROM accounts WHERE id=?`, [accId]))?.tg_token || '';
      if (!tgToken) continue;
    } else {
      const rec = sockets.get(accId);
      if (!rec?.sock) continue;
      sock = rec.sock;
      if (!sock?.user?.id) continue;
    }
    const steps = cfg.steps;
    const gateOn = (await getSetting('fu_gate_enabled', tenantId))==='1';

    const allowedStages = new Set((cfg.allowed_stages || ['unknown','human_needed']).map(s=>String(s||'').toLowerCase().trim()));

    const jrows = await all(`SELECT DISTINCT jid FROM chats WHERE tenant_id=? AND acc_id=?`,[tenantId, accId]);
    for(const r of jrows){
      const jid = String(r.jid || '');
      if (!jid) continue;

      const isGroup      = jid.endsWith('@g.us');
      const isBroadcast  = jid.endsWith('@broadcast');
      const isStatus     = jid === 'status@broadcast';
      const isNewsletter = jid.endsWith('@newsletter');

      const isDirect = !isGroup && !isBroadcast && !isStatus && !isNewsletter;
      if(!isDirect) continue;

      const blockKey=`${accId}:${jid}`;
      const b = await get(`SELECT until FROM blocks WHERE tenant_id=? AND jid=?`,[tenantId, blockKey]);
      if(b && b.until>nowSec()) continue;

      if (gateOn){
        const p = await getProfile(accId, jid); // jid, не jidCanon
        const stage = String(p?.stage || 'unknown').toLowerCase().trim() || 'unknown';
        if (!allowedStages.has(stage)) continue;
      }
      
      // Последние входящее/исходящее из чата
      const last = await get(
        `SELECT MAX(CASE WHEN type='out' THEN ts END) AS outTs,
                MAX(CASE WHEN type='in'  THEN ts END) AS inTs
          FROM chats
          WHERE tenant_id=? AND acc_id=? AND jid=?`,
        [tenantId, accId, jid]
      );
      const outTs = Number(last?.outTs || 0);
      const inTs  = Number(last?.inTs  || 0);

      // Последний отправленный Дожим (любой шаг)
      const fuMeta = await get(
        `SELECT MAX(sent_ts) AS lastFuTs
          FROM followups
          WHERE tenant_id=? AND acc_id=? AND jid=?`,
        [tenantId, accId, jid]
      );
      const lastFuTs = Number(fuMeta?.lastFuTs || 0);

      // Если клиент писал ПОСЛЕ любого нашего исходящего (ИИ/менеджер/дожим) — выходим
      const lastOurActionTs = Math.max(outTs, lastFuTs);
      if (inTs > lastOurActionTs) continue;

      // База ожидания:
      // - если уже слали дожим — считаем строго от последнего дожима;
      // - иначе — от последнего исходящего (первого «триггера» для дожима).
      const baseTs = lastFuTs || outTs;
      if (!baseTs) continue; // ещё нечего «дожимать»

      
      const sentCount = Number((await get(`SELECT COUNT(*) c FROM followups WHERE tenant_id=? AND acc_id=? AND jid=?`,[tenantId,accId,jid]))?.c||0);
      if(sentCount>=steps.length) continue;

      const step = steps[sentCount];
      const needAfterSec = (Number(step.after_min)||0)*60; if(needAfterSec<=0) continue;
      const delta = nowSec()-baseTs;
      if(delta < needAfterSec) continue;

      // render text/media
      let text = step.text||'';
      let media_file = step.media_file||'';
      let media_kind = step.media_kind||'';
      const profile = await getProfile(accId, jid);
      const llm = await getAccLLMConfig(accId);

      if (step.ai) {
        // ИИ-дожим игнорирует шаблоны/медиа и генерит текст сам
        text = await generateAiFollowupText(tenantId, accId, jid, step.ai_style||'');
        media_file = '';
        media_kind = '';
      } else {
        if (step.template_id){
          const tpl = await getTemplate(tenantId, step.template_id);
          if(tpl){
            text = tpl.body||text;
            media_file = tpl.media_file||media_file;
            media_kind = tpl.media_kind||media_kind;
          }
        }
        text = renderTextTemplate(text, profile, llm);
      }

      // === АНТИ-ДУБЛЬ: если такой же текст мы уже слали недавно — пропускаем шаг ===
      const textForDedup = (text || '').trim();
      if (textForDedup && await hasRecentlySent(tenantId, accId, jid, textForDedup, 300)) {
        // пометили шаг как «отправленный», чтобы на следующем тике не зациклиться
        await run(
          `INSERT OR REPLACE INTO followups(tenant_id, acc_id, jid, step, sent_ts)
           VALUES(?,?,?,?,?)`,
          [tenantId, accId, jid, sentCount, nowSec()]
        );
        continue;
      }

      let mf = media_file || '';
      let mk = media_kind || '';
      if (!mk && mf) mk = inferKindFromPath(mf);
      const rel = mf ? mf.replace(/^\/+/, '') : '';
      const abs = rel ? path.resolve(__dirname, rel) : '';

      try {
        const textSafe = (text == null) ? '' : String(text).trim();
        const mf = (media_file || '').replace(/^\/+/, '');
        let mk = (media_kind || '').trim();
        if (!mk && mf) mk = inferKindFromPath(mf); // 'image' | 'video' | 'audio' | 'video_note' (для новых)
        const abs = mf ? path.resolve(__dirname, mf) : '';

        let sentSomething = false;

        if (accKind === 'tg') {
          const chatId = tgJidToChatId(jid);
          if (!chatId) continue;

          if (mf && abs && fs.existsSync(abs)) {
            if (['image','video'].includes(mk)) {
                await tgSendMediaFromUploads(tgToken, chatId, mk || '', mf, textSafe || '');
            } else {
                await tgSendMediaFromUploads(tgToken, chatId, mk || '', mf, '');
                if (textSafe) { await sleep(200); await tgSendLongText(tgToken, chatId, textSafe); }
            }
            sentSomething = true;
          } else if (textSafe) {
            await tgSendLongText(tgToken, chatId, textSafe);
            sentSomething = true;
          } else {
            continue;
          }

        } else {

          // ✅ WABA: отправляем через Meta Cloud API (без Baileys)
          if (isWABA) {
            const mk2 = (mk === 'video_note') ? 'video' : mk; // у WABA нет video_note
            await sendViaWABA(accId, jid, textSafe || '', mf || '', mk2 || '');
            sentSomething = true;
          } else {

        if (mf && mk === 'image' && fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs);
          await sock.sendMessage(jid, { image: buf });
          sentSomething = true;
          if (textSafe) { await sleep(200); await sock.sendMessage(jid, { text: textSafe }); }
        } else if (mf && mk === 'video' && fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs);
          await sock.sendMessage(jid, { video: buf });
          sentSomething = true;
          if (textSafe) { await sleep(200); await sock.sendMessage(jid, { text: textSafe }); }
        } else if (mf && mk === 'video_note' && fs.existsSync(abs)) {
          // кружок (video note)
          const buf = fs.readFileSync(abs);
          // ptv: true — флаг «отправить как видео-кружок», см. Baileys docs
          await sock.sendMessage(jid, { video: buf, ptv: true });
          sentSomething = true;
          if (textSafe) { await sleep(200); await sock.sendMessage(jid, { text: textSafe }); }
        } else if (mf && mk === 'audio' && fs.existsSync(abs)) {
          // голосовое
          const meta = await normalizeAudioForWA(abs);
          const buf  = fs.readFileSync(meta.abs);
          await sock.sendMessage(jid, { audio: buf, mimetype: meta.mime, ptt: meta.ptt });
          sentSomething = true;
          if (textSafe) { await sleep(200); await sock.sendMessage(jid, { text: textSafe }); }
        } else if (textSafe) {
          await sock.sendMessage(jid, { text: textSafe });
          sentSomething = true;
        } else {
          // вообще нечего отправлять
          continue;
        }

        // ✅ WA должен быть реально подключён, иначе Baileys иногда падает на sock.user.id
        if (!sock?.user?.id) {
          throw new Error('WA not connected (sock.user is empty)');
        }
        }
        }

        // лог в БД
        const ts = nowSec(), date = new Date(ts*1000).toISOString().slice(0,10);
        const extId = crypto.randomUUID();

        await run(
          `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [tenantId, jid, date, ts,
            textSafe || (
              mk === 'image'      ? '🖼 Изображение' :
              mk === 'video'      ? '🎬 Видео' :
              mk === 'video_note' ? '📹 Видео-кружок' :
              mk === 'audio'      ? '🎧 Аудио' :
              ''
            ),
            'out', accId, mf || '', mk || '', extId
          ]
        );

        // сразу пушим в CRM (иначе таймлайн “немой”)
        await pushMessageToCRM({
          tenant_id: tenantId,
          acc_id: accId,
          jid,
          direction: 'out',
          text: textSafe || '',
          media_file: mf || '',
          media_kind: mk || '',
          external_id: extId
        });

        // === ПОМЕЧАЕМ, ЧТО ШАГ ОТПРАВЛЕН ===
        await run(
          `INSERT OR REPLACE INTO followups(tenant_id, acc_id, jid, step, sent_ts)
           VALUES(?,?,?,?,?)`,
          [tenantId, accId, jid, sentCount, nowSec()]
        );

        // эскалация «много исходящих без ответа»
        const maxOut = parseInt(await getSetting('escalate_after_out_no_reply', tenantId)||'3',10);
        const sinceTs = Math.max(outTs, lastFuTs) - 1;
        const row = await get(
          `SELECT SUM(CASE WHEN type='out' THEN 1 ELSE 0 END) outs,
                  SUM(CASE WHEN type='in'  THEN 1 ELSE 0 END) ins
            FROM chats
            WHERE tenant_id=? AND acc_id=? AND jid=? AND ts > ?`,
          [tenantId, accId, jid, sinceTs]
        );
        if (Number(row?.outs||0) >= maxOut && Number(row?.ins||0) === 0) {
          await escalate(accId, jid, 'no_reply_after_many_out', `нет ответа после ${row.outs} исходящих`);
        }

      } catch (e) {
        console.error('followup send error', accId, jid, e && (e.stack || e.message || e));
      }
    }
  }
}

async function processFirstMsgJobs(){
  const now = nowSec();
  const jobs = await all(
    `SELECT * FROM firstmsg_jobs
     WHERE status='pending' AND due_ts <= ?
     ORDER BY due_ts ASC
     LIMIT 50`,
    [now]
  );

  for (const j of jobs) {
    try {
      // WA: не шлём туда, где нет реального номера. TG — разрешаем (tg:12345)
      const isTGJid = String(j.jid || '').startsWith('tg:');
      if (!isTGJid && !jidToPhone(j.jid)) {
        await run(`UPDATE firstmsg_jobs SET status='failed', sent_ts=? WHERE id=?`, [now, j.id]);
        await run(`UPDATE firstmsg_state SET state='done', done_ts=? WHERE tenant_id=? AND acc_id=? AND jid=?`,
          [now, j.tenant_id, j.acc_id, j.jid]
        );
        continue;
      }

      const accKind = await getAccKind(j.acc_id);
      const isWABA = (accKind !== 'tg') ? await isWABAAccount(j.acc_id) : false;

      if (!isWABA && accKind !== 'tg') {
        if (!await isAccReady(j.acc_id)) {
          await run(`UPDATE firstmsg_jobs SET attempts=attempts+1, last_try_ts=? WHERE id=?`, [now, j.id]);
          continue;
        }
      }

      let sock = null;
      let tgToken = '';
      let tgChatId = null;

      if (accKind === 'tg') {
        tgChatId = tgJidToChatId(j.jid);
        const recTg = tgBots.get(j.acc_id);
        tgToken = recTg?.token || (await get(`SELECT tg_token FROM accounts WHERE id=?`, [j.acc_id]))?.tg_token || '';

        if (!tgToken || !tgChatId) {
          await run(`UPDATE firstmsg_jobs SET attempts=attempts+1, last_try_ts=? WHERE id=?`, [now, j.id]);
          continue;
        }
        } else {
          const isWABA = await isWABAAccount(j.acc_id);
          if (!isWABA) {
            const rec = sockets.get(j.acc_id);
            if (!rec?.sock) {
              await run(`UPDATE firstmsg_jobs SET attempts=attempts+1, last_try_ts=? WHERE id=?`, [now, j.id]);
              continue;
            }
            sock = rec.sock;
          }
        }

      const text = String(j.text || '').trim();
      const mediaFile = String(j.media_file || '').trim();
      let mediaKind = String(j.media_kind || '').trim().toLowerCase();
      if (!['image','video','audio','video_note',''].includes(mediaKind)) mediaKind = '';

      if (mediaFile && mediaKind) {
        if (accKind === 'tg') {
          await tgSendMediaFromUploads(tgToken, tgChatId, mediaKind, mediaFile, '');
          if (text) { await sleep(200); await tgSendLongText(tgToken, tgChatId, text); }
        } else {

          const isWABA = await isWABAAccount(j.acc_id);
          if (isWABA) {
            const mk2 = (mediaKind === 'video_note') ? 'video' : mediaKind;
            await sendViaWABA(j.acc_id, j.jid, text || '', mediaFile || '', mk2 || '');
          } else {

          if (mediaKind === 'audio' || mediaKind === 'video_note') {
            await sendMediaByPath(sock, j.jid, mediaFile, mediaKind, '');
            if (text) { await sleep(200); await sendLongText(sock, j.jid, text); }
          } else {
            await sendMediaByPath(sock, j.jid, mediaFile, mediaKind, text || '');
          }
        }
        }
        } else if (text) {
          if (accKind === 'tg') {
            await tgSendLongText(tgToken, tgChatId, text);
          } else {
            const isWABA2 = await isWABAAccount(j.acc_id);
            if (isWABA2) {
              await sendViaWABA(j.acc_id, j.jid, text, '', '');
            } else {
              await sendLongText(sock, j.jid, text);
            }
          }
        }

      // лог в БД и CRM + UI (как у media triggers)
      const tsOut = nowSec();
      const dateOut = new Date(tsOut*1000).toISOString().slice(0,10);
      const extId = crypto.randomUUID();

      const msgForLog =
        text ||
        (mediaKind === 'image' ? '🖼 Изображение' :
         mediaKind === 'video' ? '🎬 Видео' :
         mediaKind === 'video_note' ? '🎥 Видеокружок' :
         mediaKind === 'audio' ? '🎧 Аудио' : 'Сообщение');

      await run(
        `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [j.tenant_id, j.jid, dateOut, tsOut, msgForLog, 'out', j.acc_id, mediaFile, mediaKind, extId]
      );

      await pushMessageToCRM({
        tenant_id: j.tenant_id,
        acc_id: j.acc_id,
        jid: j.jid,
        direction: 'out',
        text,
        media_file: toPublicMediaPath(mediaFile),
        media_kind: mediaKind,
        external_id: extId
      });

      io.to(`tenant_${j.tenant_id}`).emit('newchat', {
        acc_id: j.acc_id,
        jid: j.jid,
        phone: await resolvePhoneForAccJid(j.acc_id, j.jid),
        text: msgForLog,
        date: dateOut,
        media_file: mediaFile,
        media_kind: mediaKind
      });

      // обновляем статус
      await run(`UPDATE firstmsg_jobs SET status='sent', sent_ts=? WHERE id=?`, [now, j.id]);
      await run(
        `UPDATE firstmsg_state
         SET state = CASE WHEN state='done' THEN state ELSE 'sent' END,
             sent_ts = COALESCE(sent_ts, ?)
         WHERE tenant_id=? AND acc_id=? AND jid=?`,
        [now, j.tenant_id, j.acc_id, j.jid]
      );

    } catch (e) {
      const tries = Number(j.attempts || 0) + 1;
      await run(`UPDATE firstmsg_jobs SET attempts=?, last_try_ts=? WHERE id=?`, [tries, now, j.id]);

      // если слишком много попыток → не блокируем ИИ навсегда
      if (tries >= 20) {
        await run(`UPDATE firstmsg_jobs SET status='failed', sent_ts=? WHERE id=?`, [now, j.id]);
        await run(`UPDATE firstmsg_state SET state='done', done_ts=? WHERE tenant_id=? AND acc_id=? AND jid=?`,
          [now, j.tenant_id, j.acc_id, j.jid]
        );
      }
    }
  }
}

// тик очереди "первого сообщения"
let firstMsgTickRunning = false;
setInterval(() => {
  if (firstMsgTickRunning) return;
  firstMsgTickRunning = true;
  Promise.resolve(processFirstMsgJobs())
    .catch(()=>{})
    .finally(() => { firstMsgTickRunning = false; });
}, 10*1000);

let followupTickRunning = false;
setInterval(() => {
  if (followupTickRunning) return;
  followupTickRunning = true;
  Promise.resolve(processFollowUps())
    .catch(()=>{})
    .finally(() => { followupTickRunning = false; });
}, 30*1000);

setInterval(async () => {
  try {
    const STALE_MS = 10 * 60 * 1000; // 10 минут
    await run(
      `UPDATE campaigns
          SET processing=0
        WHERE status='running'
          AND processing=1
          AND processing_ts < ?`,
      [Date.now() - STALE_MS]
    );
  } catch (e) { console.warn('[broadcast janitor]', e?.message || e); }
}, 60 * 1000);

// --- broadcast reentrancy lock (глобальный) ---
let broadcastTickRunning = false;
// let broadcastTickRunning = false;
async function runBroadcastTick() {
  if (broadcastTickRunning) return;   // не пускаем второй тик параллельно
  broadcastTickRunning = true;
  try {
    // берём только не занятые кампании
    const camps = await all(`SELECT * FROM campaigns WHERE status='running' AND processing=0`);
    for (const camp of camps) {
      const { id: campaign_id, tenant_id, acc_id } = camp;

      // ✅ если WA-аккаунт отвязан/оффлайн — не пытаемся слать, просто пауза
      if (!await isAccReady(acc_id)) {
        await run(`UPDATE campaigns SET status='paused', processing=0 WHERE id=?`, [campaign_id]);
        continue;
      }

      // если включён дожим — не шлём рассылку, ставим на паузу
      const fuEnabled = String(await getSetting('followup_enabled', tenant_id) || '0') === '1';
      if (fuEnabled) {
        await run(`UPDATE campaigns SET status='paused', processing=0 WHERE id=?`, [campaign_id]);
        continue;
      }

      // === атомарно «забираем» кампанию текущим воркером ===
      const nowMs = Date.now();
      const STALE_MS = 10 * 60 * 1000;
      const claim = await run(
        `UPDATE campaigns
            SET processing=1, processing_ts=?
          WHERE id=? AND status='running'
            AND (processing=0 OR processing_ts<?)`,
        [nowMs, campaign_id, nowMs - STALE_MS]
      );

      const heartbeat = makeHeartbeat(campaign_id);
      await heartbeat(); // первый «удар»

      if (claim.changes === 0) continue; // кто-то другой успел забрать

      try {
        // антибан-настройки: берём из кампании либо из settings
        const getS = async (k, def) => {
          try {
            const conf = JSON.parse(camp.settings_json || '{}');
            const vv = conf?.[k];
            if (vv !== undefined && String(vv).trim() !== '') return vv;
          } catch (_) {}
          const v = await getSetting(k, tenant_id);
          return (v !== undefined && String(v).trim() !== '') ? v : def;
        };

        const ratePerMin   = parseInt(await getS('broadcast_rate_per_min', '8'), 10);
        const batchSize    = parseInt(await getS('broadcast_batch_size',   '20'), 10);
        const sleepMin     = parseInt(await getS('broadcast_sleep_ms_min', '1200'), 10);
        const sleepMax     = parseInt(await getS('broadcast_sleep_ms_max', '3500'), 10);
        const bigSleep     = parseInt(await getS('broadcast_big_sleep_ms', '45000'), 10);
        const dailyCap     = parseInt(await getS('broadcast_daily_cap',    '400'), 10);
        const workFrom     = String(await getS('broadcast_work_from',      '09:00'));
        const workTo       = String(await getS('broadcast_work_to',        '21:00'));

        // рабочее окно
        if (!withinWorkHours(workFrom, workTo)) { await sleep(250); continue; }

        // дневной потолок на аккаунт
        const since = nowSec() - 86400;
        const todaySent = await get(
          `SELECT COUNT(*) c FROM chats WHERE tenant_id=? AND acc_id=? AND type='out' AND ts>?`,
          [tenant_id, acc_id, since]
        );
        if (Number(todaySent?.c || 0) >= dailyCap) { await sleep(250); continue; }

        const rec = sockets.get(acc_id);
        if (!rec?.sock) { await sleep(250); continue; }
        const sock = rec.sock;

        // === «захватываем» таргеты пачкой: queued -> sending ===
        const rowsToClaim = await all(
          `SELECT id FROM campaign_targets
          WHERE tenant_id=? AND campaign_id=? AND status='queued'
          ORDER BY id ASC
          LIMIT ?`,
          [tenant_id, campaign_id, Math.max(1, batchSize)]
        );

        // 🔽 ВСТАВИТЬ ЭТО ВМЕСТО старого "if (!rowsToClaim.length) { ... done ... }"
        const totalTargetsRow = await get(
          `SELECT COUNT(*) c FROM campaign_targets WHERE tenant_id=? AND campaign_id=?`,
          [tenant_id, campaign_id]
        );
        const totalTargets = Number(totalTargetsRow?.c || 0);

        // Если в кампанию пока НИ ОДНОГО таргета не загружено — не закрываем её,
        // просто пропускаем тик (вдруг таргеты догрузят позже)
        if (totalTargets === 0) {
          await sleep(250);
          continue;
        }

        // Если таргеты в принципе есть, но queued на эту итерацию не нашлось — значит всё отправлено
        if (!rowsToClaim.length) {
          await run(`UPDATE campaigns SET status='done', finished_at=? WHERE id=?`, [Date.now(), campaign_id]);
          continue;
        }

        const ids = rowsToClaim.map(r => r.id);
        const marks = ids.map(() => '?').join(',');

        // помечаем выбранные как "sending" атомарно (если кто-то уже пометил — UPDATE их не тронет)
        await run(
          `UPDATE campaign_targets SET status='sending'
           WHERE id IN (${marks}) AND status='queued'`,
          ids
        );

        // читаем только реально «захваченные» этой операцией
        const targets = await all(
          `SELECT id, jid FROM campaign_targets
           WHERE id IN (${marks}) AND status='sending'
           ORDER BY id ASC`,
          ids
        );

        if (!targets.length) {
          // ничего не осталось на эту итерацию (кто-то параллельно всё забрал)
          continue;
        }

        // текст/медиа
        // const mf  = (camp.media_file || '').replace(/^\/+/, '');
        // const mk  = camp.media_kind || '';

        const mf  = (camp.media_file || '').replace(/^\/+/, '');
        let   mk  = camp.media_kind || '';
        if (!mk && mf) mk = inferKindFromPath(mf);   // ← авто-детект 'image'/'video'

        const abs = mf ? path.resolve(__dirname, mf) : '';
        const hasMedia = mf && fs.existsSync(abs) && ['image','video','video_note','audio'].includes(mk);
        const text = (camp.text || '').trim();

        let sentInMinute = 0;
        let minuteStart  = Date.now();

        for (const t of targets) {
          // проверка статуса кампании на лету
          const fresh = await get(`SELECT status FROM campaigns WHERE id=?`, [campaign_id]);
          if (!fresh || fresh.status !== 'running') break;

          // rate per minute
          const now = Date.now();

          if (now - minuteStart >= 60000) { minuteStart = now; sentInMinute = 0; }
          if (sentInMinute >= ratePerMin) {
            const waitMs = 60000 - (now - minuteStart);
            const canceled = await sleepCoop(waitMs, async () => {
              await heartbeat();
              const fresh = await get(`SELECT status FROM campaigns WHERE id=?`, [campaign_id]);
              return !fresh || fresh.status !== 'running' || !withinWorkHours(workFrom, workTo);
            });
            if (canceled) break;
            minuteStart = Date.now();
            sentInMinute = 0;
          }

          // пропуски: заблокирован/стоп-слово?
          const blocked = await get(
            `SELECT until FROM blocks WHERE tenant_id=? AND jid=?`,
            [tenant_id, `${acc_id}:${t.jid}`]
          );
          if (blocked && blocked.until > nowSec()) {
            await run(`UPDATE campaign_targets SET status='skipped', error='blocked' WHERE id=?`, [t.id]);
            continue;
          }

          try {
            let sentSomething = false;

            if (hasMedia) {
              // медиа лежит в abs
              if (mk === 'image') {
                const buf = fs.readFileSync(abs);
                await sock.sendMessage(t.jid, { image: buf });
                sentSomething = true;
              } else if (mk === 'video') {
                const buf = fs.readFileSync(abs);
                await sock.sendMessage(t.jid, { video: buf });
                sentSomething = true;
              } else if (mk === 'video_note') {
                // кружок (video note)
                const buf = fs.readFileSync(abs);
                await sock.sendMessage(t.jid, { video: buf, ptv: true });
                sentSomething = true;
              } else if (mk === 'audio') {
                // голосовое (нормализуем под WhatsApp)
                const meta = await normalizeAudioForWA(abs);
                const buf = fs.readFileSync(meta.abs);
                await sock.sendMessage(t.jid, { audio: buf, mimetype: meta.mime, ptt: meta.ptt });
                sentSomething = true;
              }
            }

            // текст отправляем отдельно, чтобы не упасть, если медиа не удалось
            if (text && text.trim()) {
              await sock.sendMessage(t.jid, { text: text.trim() });
              sentSomething = true;
            }

            if (!sentSomething) {
              // если вообще нечего слать — просто пропускаем эту цель
              continue;
            }

            const ts = nowSec(), date = new Date(ts * 1000).toISOString().slice(0, 10);
            const extId = crypto.randomUUID();

            let msgForLog = (text || '').trim();
            if (!msgForLog) {
              if (mk === 'image')
                msgForLog = '🖼 Изображение';
              else if (mk === 'video')
                msgForLog = '🎬 Видео';
              else if (mk === 'audio')
                msgForLog = '🎧 Аудио';
              else if (mk === 'video_note')
                msgForLog = '📹 Видео-кружок';
              else
                msgForLog = '';
            }

            await run(
              `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id,campaign_id)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                [tenant_id, t.jid, date, ts,
                  msgForLog,
                  'out', acc_id, mf || '', mk || '', extId, campaign_id]
            );

            // push в CRM
            await pushMessageToCRM({
              tenant_id,
              acc_id,
              jid: t.jid,
              direction: 'out',
              text: text || '',
              media_file: mf || '',
              media_kind: mk || '',
              external_id: extId
            });

            await run(`UPDATE campaign_targets SET status='sent', sent_ts=? WHERE id=?`, [nowSec(), t.id]);

          sentInMinute++;
          const jitter = randInt(sleepMin, sleepMax);
          const canceledJitter = await sleepCoop(jitter, async () => {
            await heartbeat();
            const fresh = await get(`SELECT status FROM campaigns WHERE id=?`, [campaign_id]);
            return !fresh || fresh.status !== 'running' || !withinWorkHours(workFrom, workTo);
          });
          if (canceledJitter) break;

          } catch (e) {
            await run(
              `UPDATE campaign_targets SET status='failed', error=? WHERE id=?`,
              [String(e.message || e).slice(0, 300), t.id]
            );
            await sleep(randInt(4000, 8000));
          }
        }

      const canceledBig = await sleepCoop(bigSleep, async () => {
        await heartbeat();
        const fresh = await get(`SELECT status FROM campaigns WHERE id=?`, [campaign_id]);
        return !fresh || fresh.status !== 'running' || !withinWorkHours(workFrom, workTo);
      });
      if (canceledBig) {
        // аккуратно выходим из обработки этой кампании
        continue;
      }

      } finally {
        // освобождаем «замок» кампании в любом случае
        await run(`UPDATE campaigns SET processing=0 WHERE id=?`, [campaign_id]);
      }
    }
  } finally {
    broadcastTickRunning = false;
  }
}

setInterval(runBroadcastTick, 4000);

// -------------------------------------------------
// API: Auth / Tenants
// -------------------------------------------------
app.post('/api/auth/bootstrap', async (_req,res)=>{
  return res.status(403).json({ok:false, error:'bootstrap disabled; use /api/auth/register_public'});
});

app.post('/api/auth/signup', authGuard, async (req,res)=>{
  if(!['owner','admin'].includes(req.user.role)) return res.status(403).json({ok:false,error:'forbidden'});
  const { email, password, role='user' } = req.body||{};
  if(!email || !password) return res.status(400).json({ok:false,error:'email,password required'});
  const hash = await bcrypt.hash(password, 10);
  await run(`INSERT INTO users(tenant_id,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)`,
            [req.user.tenant_id, email, hash, role, Date.now()]);
  res.json({ok:true});
});

app.post('/api/auth/login', async (req,res)=>{
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ok:false,error:'email,password required'});

  const u = await get(`SELECT * FROM users WHERE email=?`, [email]);
  if(!u){
    console.log('[LOGIN] user not found', email);            // LOG
    return res.status(401).json({ok:false,error:'invalid credentials'});
  }

  const ok = await bcrypt.compare(password, u.pass_hash || '');

  if(!ok) return res.status(401).json({ok:false,error:'invalid credentials'});

  let verified = Number(u.email_verified || 0) === 1;

  if (!verified) {
    const autoV = isAutoVerifiedEmail(u.email); // домены @deshti.kz/@satubooster.kz :contentReference[oaicite:2]{index=2}
    const legacy = (!u.verify_token_hash) && (!u.verify_sent_at);

    if (autoV || legacy) {
      await run(
        `UPDATE users SET email_verified=1, verify_token_hash=NULL, verify_expires=NULL, verify_sent_at=NULL WHERE id=?`,
        [u.id]
      );
      verified = true;
    }
  }

  if (!verified) {
    return res.status(403).json({ ok:false, error:'email not verified' });
  }

  const token = jwt.sign({uid:u.id, tid:u.tenant_id, role:u.role, email:u.email}, JWT_SECRET, {expiresIn:'30d'});

  const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
  // ← уточняем флаги cookie, чтобы не было сюрпризов
  res.cookie('token', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000
  }).json({ok:true});
});

// -------------------------------------------------
// OAuth: Google / Apple
// -------------------------------------------------

app.get('/api/auth/google/start', (req,res)=>{
  if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET){
    return res.status(500).send('Google OAuth is not configured');
  }

  const state = crypto.randomBytes(16).toString('hex');
  setTempCookie(res, req, 'oauth_state_google', state, 10 * 60 * 1000);

  const client = getGoogleClient();
  const url = client.generateAuthUrl({
    scope: ['openid','email','profile'],
    state,
    prompt: 'select_account'
  });

  return res.redirect(url);
});

app.get('/api/auth/google/callback', async (req,res)=>{
  try{
    const { code, state, error } = req.query || {};
    if (error) return res.redirect('/login.html?oauth_error=google');

    const expected = req.cookies?.oauth_state_google;
    res.clearCookie('oauth_state_google', { path:'/' });

    if(!code || !state || !expected || String(state) !== String(expected)){
      return res.redirect('/login.html?oauth_error=google_state');
    }

    const client = getGoogleClient();
    const r = await client.getToken(String(code)); // getToken описан в доках OAuth2Client :contentReference[oaicite:1]{index=1}
    client.setCredentials(r.tokens);

    const idToken = r.tokens?.id_token;
    if(!idToken) return res.redirect('/login.html?oauth_error=google_notoken');

    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload() || {};

    const sub = p.sub;
    const email = p.email;
    const name = p.name || '';
    const picture = p.picture || '';

    const u = await findOrCreateOAuthUser({ provider:'google', sub, email, name, picture });

    const token = jwt.sign({uid:u.id, tid:u.tenant_id, role:u.role, email:u.email}, JWT_SECRET, {expiresIn:'30d'});
    setAuthCookie(res, req, token);
    return res.redirect('/?r=' + Date.now());

  }catch(e){
    if (String(e?.code||'') === 'SIGNUP_DISABLED'){
      return res.redirect('/login.html?oauth_error=signup_disabled');
    }
    console.error('[GOOGLE_OAUTH] error', e);
    return res.redirect('/login.html?oauth_error=google_fail');
  }
});

app.get('/api/auth/apple/start', (req,res)=>{
  if(!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY){
    return res.status(500).send('Apple OAuth is not configured');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  setTempCookie(res, req, 'oauth_state_apple', state, 10 * 60 * 1000, { sameSite:'none' });
  setTempCookie(res, req, 'oauth_nonce_apple', nonce, 10 * 60 * 1000, { sameSite:'none' });

  const redirectUri = `${getPublicBaseUrl()}/api/auth/apple/callback`;

  const qs = new URLSearchParams({
    response_type: 'code',
    response_mode: 'form_post',
    client_id: APPLE_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'name email',
    state,
    nonce
  });

  return res.redirect(`https://appleid.apple.com/auth/authorize?${qs.toString()}`);
});

async function handleAppleCallback(req,res){
  try{
    const code  = String(req.body?.code  || req.query?.code  || '');
    const state = String(req.body?.state || req.query?.state || '');
    const userRaw = req.body?.user;

    const expected = req.cookies?.oauth_state_apple;
    res.clearCookie('oauth_state_apple', { path:'/' });
    res.clearCookie('oauth_nonce_apple', { path:'/' });

    if(!code || !state || !expected || state !== String(expected)){
      return res.redirect('/login.html?oauth_error=apple_state');
    }

    const redirectUri = `${getPublicBaseUrl()}/api/auth/apple/callback`;
    const clientSecret = await getAppleClientSecret();
    if(!clientSecret) return res.redirect('/login.html?oauth_error=apple_secret');

    const body = new URLSearchParams({
      client_id: APPLE_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });

    const tokenResp = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    const tokenJson = await tokenResp.json().catch(()=> ({}));
    const idToken = tokenJson?.id_token;
    if(!idToken) return res.redirect('/login.html?oauth_error=apple_notoken');

    // Apple публикует ключи в JWKS; проверяем подпись/issuer/audience :contentReference[oaicite:2]{index=2}
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: APPLE_CLIENT_ID
    });

    const sub = payload.sub;
    const email = payload.email; // может прийти только в первый раз
    let name = '';
    let picture = '';

    // Apple "user" (JSON) приходит только при первом логине
    if (userRaw){
      try{
        const u = JSON.parse(String(userRaw));
        const first = u?.name?.firstName || '';
        const last  = u?.name?.lastName || '';
        name = (first + ' ' + last).trim();
      }catch(_){}
    }

    const u = await findOrCreateOAuthUser({ provider:'apple', sub, email, name, picture });

    const token = jwt.sign({uid:u.id, tid:u.tenant_id, role:u.role, email:u.email}, JWT_SECRET, {expiresIn:'30d'});
    setAuthCookie(res, req, token);
    return res.redirect('/?r=' + Date.now());

  }catch(e){
    if (String(e?.code||'') === 'SIGNUP_DISABLED'){
      return res.redirect('/login.html?oauth_error=signup_disabled');
    }
    console.error('[APPLE_OAUTH] error', e);
    return res.redirect('/login.html?oauth_error=apple_fail');
  }
}

app.post('/api/auth/apple/callback', handleAppleCallback);
app.get('/api/auth/apple/callback', handleAppleCallback);

app.post('/api/auth/logout', authGuard, (req,res)=>{
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', authGuard, async (req,res)=>{
  try{
    const row = await get(`SELECT email, email_verified, avatar_url, disabled FROM users WHERE id=?`, [req.user.id]);
    const email_verified = row ? Number(row.email_verified || 0) : 0;

    res.json({
      ok:true,
      user:{
        id: req.user.id,
        tenant_id: req.user.tenant_id,
        role: req.user.role,
        email: row?.email || req.user.email,
        email_verified,
        avatar_url: row?.avatar_url || null,
        disabled: Number(row?.disabled || 0),
        impersonating: !!(req.cookies?.admin_token)
      }
    });
  }catch(e){
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/api/me/entitlements', authGuard, async (req,res)=>{
  const ent = await getTenantEntitlements(req.user.tenant_id);
  res.json({ ok:true, ...ent });
});

// ------------------------------
// API: Admin notifications (user side)
// ------------------------------
app.get('/api/notify/pending', authGuard, async (req,res)=>{
  try{
    const uid = req.user.id;

    // админов не беспокоим глобальными уведомлениями (только таргетированные)
    const isAdmin = (req.user.role === 'admin');

    const item = await get(`
      SELECT n.id, n.text, n.image_file, n.created_at
      FROM admin_notifications n
      LEFT JOIN admin_notification_views v
        ON v.notif_id = n.id AND v.user_id = ?
      WHERE n.is_active = 1
        AND v.notif_id IS NULL
        AND (
          (${isAdmin ? 0 : 1} AND n.target_all = 1)
          OR EXISTS(
            SELECT 1 FROM admin_notification_targets t
            WHERE t.notif_id = n.id AND t.user_id = ?
          )
        )
      ORDER BY n.created_at DESC
      LIMIT 1
    `, [uid, uid]);

    if(!item) return res.json({ ok:true, item:null });

    const image_url = item.image_file ? ('/' + String(item.image_file).replace(/^\/+/, '')) : null;

    res.json({
      ok:true,
      item:{
        id: item.id,
        text: item.text,
        image_url,
        created_at: item.created_at
      }
    });
  }catch(e){
    console.error('GET /api/notify/pending error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/notify/seen', authGuard, async (req,res)=>{
  try{
    const uid = req.user.id;
    const id = Number(req.body?.id || 0);
    if(!id) return res.status(400).json({ ok:false, error:'id required' });

    const n = await get(`SELECT id, target_all, is_active FROM admin_notifications WHERE id=?`, [id]);
    if(!n || Number(n.is_active||0)!==1) return res.status(404).json({ ok:false, error:'not found' });

    // проверим что юзер реально был таргетом
    if(Number(n.target_all||0) === 1){
      if(req.user.role === 'admin') return res.status(403).json({ ok:false, error:'forbidden' });
    } else {
      const t = await get(`SELECT 1 x FROM admin_notification_targets WHERE notif_id=? AND user_id=?`, [id, uid]);
      if(!t) return res.status(403).json({ ok:false, error:'forbidden' });
    }

    await run(`INSERT OR IGNORE INTO admin_notification_views(notif_id, user_id, seen_at) VALUES(?,?,?)`, [id, uid, Date.now()]);
    res.json({ ok:true });
  }catch(e){
    console.error('POST /api/notify/seen error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

// ------------------------------
// API: Profile
// ------------------------------
app.get('/api/profile', authGuard, async (req,res)=>{
  try{
    const u = await get(`SELECT email, email_verified, avatar_url, disabled FROM users WHERE id=?`, [req.user.id]);
    if(!u) return res.status(404).json({ ok:false, error:'user not found' });
    res.json({
      ok:true,
      email: u.email,
      email_verified: Number(u.email_verified || 0),
      avatar_url: u.avatar_url || null
    });
  }catch(e){
    console.error('GET /api/profile error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/profile/email', authGuard, async (req,res)=>{
  try{
    const email = String(req.body?.email || '').trim().toLowerCase();
    if(!email) return res.status(400).json({ ok:false, error:'email required' });
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, error:'invalid email' });

    const exists = await get(`SELECT id FROM users WHERE lower(email)=? AND id<>?`, [email, req.user.id]);
    if(exists) return res.status(409).json({ ok:false, error:'email already exists' });

    const autoV = isAutoVerifiedEmail(email);
    const now = Date.now();

    let email_verified = autoV ? 1 : 0;
    let verify_token_hash = null;
    let verify_expires = null;
    let verify_sent_at = null;

    let mailSent = false;
    let message = 'Почта обновлена';

    if(!autoV){
      const rawToken = crypto.randomBytes(32).toString('hex');
      verify_token_hash = sha256hex(rawToken);
      verify_expires = now + 24 * 3600 * 1000;
      verify_sent_at = now;

      try{
        const r = await sendVerifyEmail(email, rawToken);
        mailSent = !!r.ok;
      }catch(e){
        console.warn('[PROFILE] sendVerifyEmail failed:', e?.message || e);
      }

      message = mailSent
        ? 'Почта обновлена. Отправили письмо для подтверждения.'
        : 'Почта обновлена. Письмо для подтверждения не удалось отправить.';
    }

    await run(
      `UPDATE users
       SET email=?, email_verified=?, verify_token_hash=?, verify_expires=?, verify_sent_at=?
       WHERE id=?`,
      [email, email_verified, verify_token_hash, verify_expires, verify_sent_at, req.user.id]
    );

    // обновляем JWT cookie, чтобы в токене была новая почта
    const token = jwt.sign(
      { uid:req.user.id, tid:req.user.tenant_id, role:req.user.role, email },
      JWT_SECRET,
      { expiresIn:'30d' }
    );
    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
    res.cookie('token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok:true, message, mail_sent: mailSent, email_verified });
  }catch(e){
    console.error('POST /api/profile/email error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/profile/password', authGuard, async (req,res)=>{
  try{
    const password = String(req.body?.password || '');
    if(password.length < 8) return res.status(400).json({ ok:false, error:'password too short' });

    const hash = await bcrypt.hash(password, 10);
    await run(`UPDATE users SET pass_hash=? WHERE id=?`, [hash, req.user.id]);

    res.json({ ok:true, message:'Пароль обновлён' });
  }catch(e){
    console.error('POST /api/profile/password error', e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/profile/avatar', authGuard, (req,res)=>{
  uploadAvatar.single('avatar')(req, res, async (err)=>{
    try{
      if(err) return res.status(400).json({ ok:false, error: err.message || 'upload error' });
      if(!req.file) return res.status(400).json({ ok:false, error:'no file' });

      const rel = path.posix.join(
        'uploads', 'avatars',
        String(req.user.tenant_id),
        String(req.user.id),
        req.file.filename
      );

      await run(`UPDATE users SET avatar_url=? WHERE id=?`, [rel, req.user.id]);
      res.json({ ok:true, message:'Аватар обновлён', avatar_url: rel });
    }catch(e){
      console.error('POST /api/profile/avatar error', e);
      res.status(500).json({ ok:false, error:'server error' });
    }
  });
});

app.get('/api/tenant', authGuard, async (req,res)=>{
  // На будущее можно будет подтянуть имя тенанта из таблицы tenants,
  // сейчас нам достаточно вернуть id.
  if (!req.user.tenant_id) {
    return res.status(404).json({ ok:false, error:'no tenant' });
  }

  res.json({
    ok: true,
    tenant_id: req.user.tenant_id,
    tenant_name: null
  });
});

// Публичная регистрация включена?
app.get('/api/auth/open_signup', async (_req,res)=>{
  const enabled = (await getSetting('open_signup', 1) || '0') === '1';
  const role    = (await getSetting('open_signup_role', 1) || 'user');
  res.json({ enabled, role });
});

app.get('/api/auth/verify', async (req,res)=>{
  try{
    const token = String(req.query.token || '').trim();
    if(!token) return res.status(400).send('Bad request');

    const hash = sha256hex(token);
    const now = Date.now();

    const u = await get(
      `SELECT id, email_verified, verify_expires
       FROM users
       WHERE verify_token_hash=?`,
      [hash]
    );

    if(!u || !u.verify_expires || Number(u.verify_expires) < now){
      return res.status(400).send('Invalid or expired token');
    }

    await run(
      `UPDATE users SET
         email_verified=1,
         verify_token_hash=NULL,
         verify_expires=NULL,
         verify_sent_at=NULL
       WHERE id=?`,
      [u.id]
    );

    // удобный редирект обратно на логин
    return res.redirect('/?verified=1');

  }catch(e){
    console.error('[VERIFY] error', e);
    return res.status(500).send('Server error');
  }
});

// Повторная отправка письма подтверждения (anti-spam)
app.post('/api/auth/resend_verify', async (req,res)=>{
  try{
    const email = String(req.body?.email || '').trim().toLowerCase();
    if(!email) return res.status(400).json({ ok:false, error:'email required' });

    // Не палим существование аккаунта: если нет юзера — всё равно ok:true
    const u = await get(
      `SELECT id, email_verified, verify_sent_at
       FROM users
       WHERE email=?`,
      [email]
    );

    if(!u) return res.json({ ok:true, sent:false });

    // Уже подтверждён — не шлём
    if(Number(u.email_verified || 0) === 1){
      return res.json({ ok:true, sent:false, already_verified:true });
    }

    // cooldown
    const cooldownMs = Number(process.env.VERIFY_RESEND_COOLDOWN_MS || 60_000);
    const last = Number(u.verify_sent_at || 0);
    const now = Date.now();

    if(last && (now - last) < cooldownMs){
      const retry_in = Math.ceil((cooldownMs - (now - last)) / 1000);
      return res.status(429).json({ ok:false, error:'cooldown', retry_in });
    }

    // новый токен
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256hex(rawToken);
    const expires = now + 24 * 3600 * 1000; // 24 часа

    await run(
      `UPDATE users SET verify_token_hash=?, verify_expires=?, verify_sent_at=? WHERE id=?`,
      [tokenHash, expires, now, u.id]
    );

    let mailSent = false;
    try{
      const r = await sendVerifyEmail(email, rawToken);
      mailSent = !!r.ok;
    }catch(e){
      console.warn('[RESEND_VERIFY] sendVerifyEmail failed:', e?.message || e);
    }

    return res.json({ ok:true, sent: mailSent });
  }catch(e){
    console.error('[RESEND_VERIFY] error', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

// ------------------------------
// API: Forgot/Reset password
// ------------------------------
app.post('/api/auth/forgot_password', async (req,res)=>{
  try{
    const email = String(req.body?.email || '').trim().toLowerCase();
    if(!email) return res.status(400).json({ ok:false, error:'email required' });
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, error:'invalid email' });

    // Не палим существование аккаунта
    const u = await get(`SELECT id, reset_sent_at FROM users WHERE email=?`, [email]);
    if(!u) return res.json({ ok:true, sent:false });

    // cooldown анти-спам
    const cooldownMs = Number(process.env.RESET_RESEND_COOLDOWN_MS || 60_000);
    const last = Number(u.reset_sent_at || 0);
    const now = Date.now();
    if(last && (now - last) < cooldownMs){
      const retry_in = Math.ceil((cooldownMs - (now - last)) / 1000);
      return res.status(429).json({ ok:false, error:'cooldown', retry_in });
    }

    // новый токен
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256hex(rawToken);
    const ttlMs = Number(process.env.RESET_TOKEN_TTL_MS || (60 * 60 * 1000)); // 1 час
    const expires = now + ttlMs;

    await run(
      `UPDATE users SET reset_token_hash=?, reset_expires=?, reset_sent_at=? WHERE id=?`,
      [tokenHash, expires, now, u.id]
    );

    let mailSent = false;
    try{
      const r = await sendResetEmail(email, rawToken);
      mailSent = !!r.ok;
    }catch(e){
      console.warn('[FORGOT_PASSWORD] sendResetEmail failed:', e?.message || e);
    }

    return res.json({ ok:true, sent: mailSent });
  }catch(e){
    console.error('[FORGOT_PASSWORD] error', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/auth/reset_password', async (req,res)=>{
  try{
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');

    if(!token) return res.status(400).json({ ok:false, error:'token required' });
    if(password.length < 8) return res.status(400).json({ ok:false, error:'password too short' });

    const now = Date.now();
    const hash = sha256hex(token);

    const u = await get(
      `SELECT id FROM users
       WHERE reset_token_hash=?
         AND reset_expires IS NOT NULL
         AND reset_expires >= ?`,
      [hash, now]
    );

    if(!u) return res.status(400).json({ ok:false, error:'invalid or expired token' });

    const pass_hash = await bcrypt.hash(password, 10);

    await run(
      `UPDATE users SET
         pass_hash=?,
         reset_token_hash=NULL,
         reset_expires=NULL,
         reset_sent_at=NULL
       WHERE id=?`,
      [pass_hash, u.id]
    );

    return res.json({ ok:true });
  }catch(e){
    console.error('[RESET_PASSWORD] error', e);
    return res.status(500).json({ ok:false, error:'server error' });
  }
});

app.post('/api/auth/register_public', async (req,res)=>{
  try{
    // Глобальный флаг: разрешена ли публичная регистрация
    const enabled = (await getSetting('open_signup', 1) || '0') === '1';
    if(!enabled) return res.status(403).json({ok:false, error:'open_signup disabled'});

    const role = 'user';
    const { email, password } = req.body||{};
    if(!email || !password) return res.status(400).json({ok:false,error:'email,password required'});

    const exists = await get(`SELECT id FROM users WHERE email=?`, [email]);
    if(exists) return res.status(409).json({ok:false,error:'email already exists'});

    // 👇 гарантированно уникальное имя тенанта
    const local = (email.split('@')[0] || 'user').replace(/[^a-z0-9_-]/gi,'').slice(0,24);
    const uniqueSuffix = Math.random().toString(36).slice(2,8); // 6 символов
    const tenantName = `${local || 'user'}-${uniqueSuffix}`;

    const tIns = await run(`INSERT INTO tenants(name,created_at) VALUES(?,?)`, [tenantName, Date.now()]);
    const tid  = tIns.lastID;

    await seedDefaultsForTenant(tid);

    const hash = await bcrypt.hash(password, 10);
    const autoV = isAutoVerifiedEmail(email);
    const uIns = await run(
      `INSERT INTO users(tenant_id,email,pass_hash,role,created_at,email_verified)
       VALUES(?,?,?,?,?,?)`,
      [tid, email, hash, role, Date.now(), autoV ? 1 : 0]
    );

    // ✅ Автоматическое начисление SatuCoin новым пользователям (настраивается в админке)
    try{
      const bonus = Number(await getSetting('satu_signup_bonus', 0) || 0);
      if(Number.isFinite(bonus) && bonus > 0){
        await changeSatuBalance(tid, Math.floor(bonus), {
          userId: uIns.lastID,
          reason: 'signup_bonus',
          meta: { source:'register_public' }
        });
      }
    }catch(e){
      console.warn('[REGISTER] signup bonus not applied:', e?.message || e);
    }

    // если корпоративная почта — сразу логиним (без письма)
    if (autoV){
      const token = jwt.sign({uid:uIns.lastID, tid, role, email}, JWT_SECRET, {expiresIn:'30d'});
      const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
      res.cookie('token', token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 3600 * 1000
      });
      return res.json({ ok:true, auto_verified:true });
    }

    // иначе — создаём токен и отправляем письмо
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256hex(rawToken);
    const now = Date.now();
    const expires = now + 24 * 3600 * 1000; // 24 часа

    await run(
      `UPDATE users SET verify_token_hash=?, verify_expires=?, verify_sent_at=? WHERE id=?`,
      [tokenHash, expires, now, uIns.lastID]
    );

    let mailSent = false;
    try{
      const r = await sendVerifyEmail(email, rawToken);
      mailSent = !!r.ok;
      if (!r.ok) console.warn('[REGISTER] verify email not sent:', r.error);
    }catch(e){
      console.warn('[REGISTER] sendVerifyEmail failed:', e?.message || e);
    }

    // Важно: после регистрации пускаем пользователя в панель, но UI заблокирует доступ до подтверждения email
    const token = jwt.sign({uid:uIns.lastID, tid, role, email}, JWT_SECRET, {expiresIn:'30d'});
    const isSecure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
    res.cookie('token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });
    return res.json({ ok:true, needs_verify:true, mail_sent: mailSent });

  }catch(e){
    // если вдруг всё же столкнёмся с UNIQUE — пробуем ещё раз с другим суффиксом
    if(String(e.message||'').includes('UNIQUE constraint failed: tenants.name')){
      return res.status(409).json({ok:false,error:'try again'});
    }
    return res.status(500).json({ok:false,error:e.message});
  }
});

app.post('/api/apikeys', authGuard, async (req,res)=>{
  const { label } = req.body||{};
  const key = 'nk_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  await run(`INSERT INTO api_keys(tenant_id,label,key,created_at) VALUES(?,?,?,?)`,[req.user.tenant_id,label||'',key,Date.now()]);
  res.json({ok:true, key});
});

// Защищённая панель: если не залогинен — login.html
app.get('/', optAuth, async (req,res)=>{
  if(!req.user) return res.sendFile(path.join(__dirname,'panel','login.html'));

  // если аккаунт отключён — отправляем на логин и чистим cookie
  try{
    const row = await get(`SELECT disabled FROM users WHERE id=?`, [req.user.id]);
    if (row && Number(row.disabled || 0) === 1){
      res.clearCookie('token', { path:'/' });
      return res.sendFile(path.join(__dirname,'panel','login.html'));
    }
  }catch(_){}

  return res.sendFile(path.join(__dirname,'panel','index.html'));
});

// -------------------------------------------------
// Instagram (Meta) — separate module
// -------------------------------------------------
function igGraphUrl(path){
  // можно потом вынести версию в env, но так стабильнее
  return `https://graph.facebook.com/v21.0${path}`;
}

async function igFetchJson(url, opts){
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch(_){}
  if(!r.ok){
    const msg = j?.error?.message || t || 'IG request failed';
    const e = new Error(msg);
    e.status = r.status;
    e.body = j || t;
    throw e;
  }
  return j || {};
}

app.get('/api/ig/status', authGuard, async (req,res)=>{
  const tid = Number(req.user.tenant_id||1);

  // keep `accounts` in sync, so UI can show a real acc_id + online/offline
  try{ await igSyncAccountFromConn(tid); }catch(_){}

  const row = await get(
    `SELECT page_id, ig_user_id, username, status, last_error, connected_at
     FROM ig_connections WHERE tenant_id=?`,
    [tid]
  );
  const enabled = (await getSetting('ig_enabled', tid)) === '1';

  const acc = await get(
    `SELECT id, label, status FROM accounts
      WHERE tenant_id=? AND (kind='ig' OR lower(kind)='instagram')
      ORDER BY id LIMIT 1`,
    [tid]
  );

  res.json({
    ok:true,
    connected: !!row,
    ig_enabled: enabled ? 1 : 0,
    acc_id: acc?.id || null,
    acc_label: acc?.label || null,
    acc_status: acc?.status || null,
    ...row
  });
});

app.post('/api/ig/config', authGuard, async (req,res)=>{
  const v = req.body?.ig_enabled;
  const enabled = (v === true || v === 1 || v === '1' || v === 'true');
  await setSetting('ig_enabled', enabled ? '1' : '0', req.user.tenant_id);
  res.json({ ok:true, ig_enabled: enabled ? 1 : 0 });
});

app.post('/api/ig/disconnect', authGuard, async (req,res)=>{
  const tid = Number(req.user.tenant_id||1);
  await run(`DELETE FROM ig_connections WHERE tenant_id=?`, [tid]);

  // keep IG acc_id stable: just mark offline
  await run(
    `UPDATE accounts SET status='offline', updated_at=? WHERE tenant_id=? AND (kind='ig' OR lower(kind)='instagram')`,
    [Date.now(), tid]
  );

  res.json({ok:true});
});

app.get('/api/ig/connect', authGuard, async (req,res)=>{
  igAssertEnv();
  const tid = Number(req.user.tenant_id||1);

  // state: привязка к tenant и защита
  const state = jwt.sign({ tid, t: Date.now() }, JWT_SECRET, { expiresIn:'10m' });

  const redirectUri = `${getPublicBaseUrl()}/api/ig/callback`;

  // Instagram Messaging требует эти permissions (минимум)
  // instagram_basic, instagram_manage_messages, pages_manage_metadata, pages_showlist, business_management
  const scope = [
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'pages_manage_metadata',
    'pages_show_list',
    'business_management'
  ].join(',');

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(IG_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}`;

  res.redirect(url);
});

app.get('/api/ig/callback', async (req,res)=>{
  try{
    igAssertEnv();
    const { code, state } = req.query||{};
    if(!code || !state) return res.status(400).send('Missing code/state');

    const payload = jwt.verify(String(state), JWT_SECRET);
    const tid = Number(payload?.tid||1);

    const redirectUri = `${getPublicBaseUrl()}/api/ig/callback`;

    // 1) code -> short-lived user token
    const tokenResp = await igFetchJson(
      igGraphUrl(`/oauth/access_token?client_id=${encodeURIComponent(IG_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(IG_APP_SECRET)}&code=${encodeURIComponent(code)}`)
    );

    const shortUserToken = tokenResp.access_token;

    // 2) short -> long-lived user token (до ~60 дней)
    const llResp = await igFetchJson(
      igGraphUrl(`/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(IG_APP_ID)}&client_secret=${encodeURIComponent(IG_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(shortUserToken)}`)
    );
    const userToken = llResp.access_token;
    const expiresIn = Number(llResp.expires_in||0);
    const expiresAt = expiresIn ? (Date.now() + expiresIn*1000) : 0;

    // 3) получаем страницы, где есть instagram_business_account
    const pages = await igFetchJson(
      igGraphUrl(`/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`)
    );

    const data = Array.isArray(pages?.data) ? pages.data : [];
    const pick = data.find(x => x?.instagram_business_account?.id);
    if(!pick){
      await run(`INSERT OR REPLACE INTO ig_connections(tenant_id,status,last_error) VALUES(?,?,?)`, [tid,'error','No connected Instagram Business/Creator account found (connect IG to a Facebook Page)']);
      return res.redirect('/index.html?ig=error#accounts');
    }

    const pageId = String(pick.id);
    const igUserId = String(pick.instagram_business_account.id);
    const username = String(pick.instagram_business_account.username || '');

    // 4) page access token (нужен для send API)
    const pageTok = await igFetchJson(
      igGraphUrl(`/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`)
    );
    const pageToken = String(pageTok?.access_token || userToken);

    // 5) подписываем приложение на страницу (чтобы webhook реально слал события)
    // (если уже подписано — ок)
    try{
      await igFetchJson(
        igGraphUrl(`/${pageId}/subscribed_apps`),
        {
          method:'POST',
          headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
          body:`subscribed_fields=messages,messaging_postbacks,message_reactions,messaging_seen&access_token=${encodeURIComponent(pageToken)}`
        }
      );
    }catch(e){
      // не блокируем подключение, просто сохраним предупреждение
      console.warn('[IG] subscribe failed:', e.message);
    }

    await run(
      `INSERT OR REPLACE INTO ig_connections(tenant_id,page_id,ig_user_id,username,access_token,token_expires_at,connected_at,status,last_error)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [tid, pageId, igUserId, username, pageToken, expiresAt, Date.now(), 'connected', '']
    );

    // create/update a real IG account row in `accounts` (kind='ig') so UI gets a stable acc_id
    try{ await igSyncAccountFromConn(tid); }catch(_){ }

    return res.redirect('/index.html?ig=connected#accounts');
  }catch(e){
    console.error('[IG CALLBACK]', e);
    return res.status(500).send('IG callback error: ' + (e.message||''));
  }
});

async function igSendText(pageToken, recipientId, text){
  const url = igGraphUrl(`/me/messages`);
  const payload = {
    messaging_type: 'RESPONSE',
    recipient: { id: String(recipientId) },
    message: { text: String(text || '').slice(0, 950) }
  };

  const r = await fetch(url + `?access_token=${encodeURIComponent(pageToken)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });

  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`IG send failed: ${r.status} ` + JSON.stringify(j));
  return j;
}

function igSplitText(text, limit = 950){
  const s = String(text || '').replace(/\r/g, '');
  if (s.length <= limit) return [s];

  const out = [];
  const blocks = s.split(/\n{2,}/g);

  let cur = '';
  for (const b of blocks) {
    const part = (cur ? cur + '\n\n' : '') + b;

    if (part.length <= limit) {
      cur = part;
      continue;
    }

    if (cur) out.push(cur);
    cur = '';

    if (b.length <= limit) {
      cur = b;
    } else {
      // fallback: режем по символам
      for (let i = 0; i < b.length; i += limit) {
        out.push(b.slice(i, i + limit));
      }
    }
  }
  if (cur) out.push(cur);

  return out.filter(x => String(x).trim().length > 0);
}

async function igSendLongText(pageToken, recipientId, text, limit = 950){
  const chunks = igSplitText(text, limit);
  for (const ch of chunks) {
    await igSendText(pageToken, recipientId, ch);
    await sleep(250);
  }
}

async function igSendPrivateReplyToComment(pageToken, commentId, text){
  // Private Replies: 1 сообщение в Direct в ответ на комментарий
  const url = igGraphUrl(`/me/messages`);
  const payload = {
    messaging_type: 'RESPONSE',
    recipient: { comment_id: String(commentId) },
    message: { text: String(text || '').slice(0, 950) }
  };

  const r = await fetch(url + `?access_token=${encodeURIComponent(pageToken)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });

  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`IG private reply failed: ${r.status} ` + JSON.stringify(j));
  return j;
}

async function igSendAttachment(pageToken, recipientId, type, fileRel){
  // fileRel: "uploads/xxx.ext"
  const base = getPublicBaseUrl();
  const rel  = String(fileRel||'').replace(/^\/+/,'');
  const url  = base + '/' + rel;

  const payload = {
    messaging_type: 'RESPONSE',
    recipient: { id: String(recipientId) },
    message: {
      attachment: {
        type: String(type||'file'),
        payload: { url, is_reusable: true }
      }
    }
  };

  const r = await fetch(igGraphUrl(`/me/messages`) + `?access_token=${encodeURIComponent(pageToken)}`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error('IG attachment send failed: ' + r.status + ' ' + t.slice(0,300));
  }
  return r.json().catch(()=>({}));
}

async function igReplyToComment(pageToken, commentId, message){
  const url = igGraphUrl(`/${encodeURIComponent(String(commentId))}/replies`);
  const r = await fetch(url + `?access_token=${encodeURIComponent(pageToken)}`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message: String(message||'').slice(0, 950) })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error('IG comment reply failed: ' + r.status + ' ' + t.slice(0,300));
  }
  return r.json().catch(()=>({}));
}

async function igCommentOnMedia(pageToken, mediaId, message){
  const url = igGraphUrl(`/${encodeURIComponent(String(mediaId))}/comments`);
  const r = await fetch(url + `?access_token=${encodeURIComponent(pageToken)}`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message: String(message||'').slice(0, 950) })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error('IG media comment failed: ' + r.status + ' ' + t.slice(0,300));
  }
  return r.json().catch(()=>({}));
}

async function igReplyToMention(pageToken, igUserId, { commentId=null, mediaId=null }, message){
  const uid = String(igUserId || '').trim();
  const mid = String(mediaId || '').trim();
  const cid = String(commentId || '').trim();
  if (!uid) throw new Error('igReplyToMention: missing igUserId');
  if (!mid) throw new Error('igReplyToMention: missing mediaId');

  // Graph API надёжнее принимает form-urlencoded для таких endpoint’ов
  const params = new URLSearchParams();
  params.set('message', String(message || '').slice(0, 950));
  params.set('media_id', mid);
  if (cid) params.set('comment_id', cid);

  const url = igGraphUrl(`/${encodeURIComponent(uid)}/mentions`);
  const r = await fetch(url + `?access_token=${encodeURIComponent(pageToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if(!r.ok){
    const t = await r.text().catch(()=> '');
    throw new Error('IG mentions reply failed: ' + r.status + ' ' + t.slice(0,300));
  }
  return r.json().catch(()=>({}));
}

async function igLoadHistory(tenantId, threadId, limit=18){
  const rows = await all(
    `SELECT direction, text
     FROM ig_chats
     WHERE tenant_id=? AND thread_id=?
     ORDER BY id DESC
     LIMIT ?`,
    [tenantId, threadId, limit]
  );
  rows.reverse();
  return rows.map(r => ({
    role: (String(r.direction) === 'out') ? 'assistant' : 'user',
    content: String(r.text || '')
  }));
}

async function igMakeAIReply(tenantId, threadId, userContent, opts = {}){
  const openaiKey = await getOpenAIKeyForTenant(tenantId);
  if(!openaiKey) return '';

  const sys = String(await getSetting('ig_system_prompt', tenantId) || '').trim();

  const ctxN = Math.max(0, Math.min(50, Number(await getSetting('ig_ctx_messages', tenantId) || 18)));
  const history = await igLoadHistory(tenantId, threadId, ctxN);

  const openai = new OpenAI({ apiKey: openaiKey });

  const model = String(opts.model || 'gpt-4o-mini');

  const messages = [
    ...(sys ? [{ role:'system', content: sys }] : []),
    ...history,
    { role:'user', content: userContent } // ВАЖНО: не String(), чтобы можно было передать parts
  ];

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.6,
    max_tokens: 900,
    messages
  });

  return String(resp.choices?.[0]?.message?.content || '').trim();
}

// Webhook verification (Meta will call GET with hub.challenge)
app.get('/webhook/ig', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if(mode === 'subscribe' && token === IG_VERIFY_TOKEN){
    return res.status(200).send(String(challenge||''));
  }
  return res.sendStatus(403);
});

function parseStopList(raw){
  return String(raw||'')
    .split(/\r?\n/g)
    .map(s=>s.trim().toLowerCase())
    .filter(Boolean);
}
function inStopList(list, senderId, username){
  const sid = String(senderId||'').trim().toLowerCase();
  const un  = String(username||'').trim().replace(/^@/,'').toLowerCase();
  if (sid && list.includes(sid)) return true;
  if (un && (list.includes('@'+un) || list.includes(un))) return true;
  return false;
}

// IG: иногда username не приходит в DM webhook, поэтому пробуем подтянуть через Graph API
const igUserCache = new Map(); // senderId -> { username, exp }

// IG webhook dedup (чтобы не отвечать дважды на один и тот же mid)
const igDedupCache = new Map();

function igSeenRecently(key, ttlMs = 5 * 60 * 1000) {
  const now = Date.now();
  const prev = igDedupCache.get(key);
  if (prev && (now - prev) < ttlMs) return true;

  igDedupCache.set(key, now);

  // легкая чистка, чтобы Map не рос бесконечно
  if (igDedupCache.size > 5000) {
    for (const [k, t] of igDedupCache) {
      if ((now - t) > ttlMs) igDedupCache.delete(k);
    }
  }
  return false;
}

async function igResolveUsername(pageToken, senderId){
  const sid = String(senderId || '').trim();
  if (!sid) return '';

  const now = Date.now();
  const cached = igUserCache.get(sid);
  if (cached && cached.exp > now) return cached.username || '';

  try{
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(sid)}?fields=username,name&access_token=${encodeURIComponent(pageToken)}`;
    const r = await fetch(url);
    const j = await r.json().catch(()=>({}));
    if (!r.ok) return '';

    const u = String(j.username || '').trim();
    igUserCache.set(sid, { username: u, exp: now + 6*60*60*1000 }); // 6 часов
    return u;
  }catch(_){
    return '';
  }
}

async function igGraphGet(pageToken, id, fields){
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`;
  const r = await fetch(url);
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

function igDmAttachmentsFromEvent(ev){
  try{
    const ev0 = ev?.value || ev || {};
    const atts = Array.isArray(ev0?.message?.attachments) ? ev0.message.attachments : [];

    return atts.map(a=>{
      const type = String(a?.type || 'attachment').toLowerCase();
      const pl = (a && typeof a.payload === 'object' && a.payload) ? a.payload : {};
      return {
        type,
        url:  String(pl.url || '').trim(),
        mime: String(pl.mime_type || '').trim(),
        title: String(pl.title || pl.name || '').trim(),
        text:  String(pl.text || pl.description || '').trim(),
        media_id: String(pl.ig_post_media_id || '').trim(),
        payload: pl, // ✅ сохраняем сырой payload (нужно для share/reels)
      };
    }).filter(x => x.type);
  }catch(_){
    return [];
  }
}

// ===== IG DM media helpers (no-duplicates, reliable MIME/ext) =====
function igExtFromMime(ct){
  ct = String(ct || '').split(';')[0].trim().toLowerCase();
  const m = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',

    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',

    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/webm': 'webm',
  };
  return m[ct] || null;
}

function igMimeFromExt(ext){
  ext = String(ext || '').toLowerCase().replace('.', '');
  const m = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',

    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',

    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
  };
  return m[ext] || 'application/octet-stream';
}

function igGuessExtFromUrl(u, fallback='bin'){
  try{
    const p = new URL(u).pathname || '';
    const m = p.match(/\.([a-z0-9]{2,6})$/i);
    if (m) return m[1].toLowerCase();
  }catch(_){}
  return fallback;
}

// simple magic-byte sniff for images (fixes octet-stream)
function igSniffImageMime(buf){
  try{
    if (!buf || buf.length < 12) return null;
    // JPEG
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    // WEBP: RIFF....WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  }catch(_){}
  return null;
}

// Download IG media to /tmp with a hard size limit (prevents big reels from breaking the whole flow)
async function igDownloadToTmp(url, prefix='ig', hintedMime='', maxBytes = 30 * 1024 * 1024){
  if (!url) throw new Error('empty url');

  const r = await fetchWithTimeout(url, {}, 30000);
  if (!r.ok) throw new Error(`download failed HTTP ${r.status}`);

  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(`download too large: ${buf.length} bytes`);
  }

  // best-effort mime detection
  const hdrCt = String(r.headers?.get?.('content-type') || '').trim();
  let mime = (hintedMime || hdrCt).split(';')[0].trim().toLowerCase();

  // fix for IG CDN returning octet-stream for images
  if (!mime || mime === 'application/octet-stream'){
    const sniff = igSniffImageMime(buf);
    if (sniff) mime = sniff;
  }

  let ext = igExtFromMime(mime);
  if (!ext) ext = igGuessExtFromUrl(url, 'bin');

  const fp = path.join('/tmp', `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  fs.writeFileSync(fp, buf);
  return { fp, mime: mime || igMimeFromExt(ext), ext };
}

async function igExtractAudioFromVideo(absVideoPath){
  return new Promise((resolve) => {
    try{
      const outMp3 = path.join('/tmp', `ig-audio-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
      execFile(process.env.FFMPEG_BIN || 'ffmpeg',
        ['-y','-hide_banner','-loglevel','error','-i', absVideoPath, '-vn','-ac','1','-ar','16000', outMp3],
        { timeout: 60000 },
        (err)=>{
          if (err) return resolve(null);
          fs.access(outMp3, fs.constants.R_OK, (e)=> resolve(e ? null : outMp3));
        }
      );
    }catch(_){ resolve(null); }
  });
}

async function igTranscribeLocalFile(tenantId, filePath){
  const openaiKey = await getOpenAIKeyForTenant(tenantId);
  if (!openaiKey) return '';

  const st = fs.statSync(filePath);
  if (st.size > 25 * 1024 * 1024) return ''; // safe

  const openai = new OpenAI({ apiKey: openaiKey });

  const tr = await openai.audio.transcriptions.create({
    model: 'gpt-4o-mini-transcribe',
    file: fs.createReadStream(filePath),
    response_format: 'text'
  });

  return String(tr?.text || tr || '').trim();
}
// ===== /IG DM media helpers =====

async function igOembedGet(permalink){
  try{
    if (!permalink) return null;
    // у тебя они уже есть сверху файла:
    // const IG_APP_ID = process.env.IG_APP_ID || '';
    // const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
    if (!IG_APP_ID || !IG_APP_SECRET) return null;

    const accessToken = `${IG_APP_ID}|${IG_APP_SECRET}`;
    const url =
      `https://graph.facebook.com/v20.0/instagram_oembed` +
      `?url=${encodeURIComponent(permalink)}` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    const r = await fetch(url);
    const j = await r.json().catch(()=>({}));
    if (!r.ok) return null;
    return j; // { title, author_name, ... }
  }catch(_){
    return null;
  }
}

// Resolve IG DM "share" (post/reel) into text context + preview image (data-url).
async function igResolveShareForMarketing(pageToken, att){
  try{
    const url0 = String(att?.url || '').trim();
    const mediaId = String(att?.media_id || '').trim();

    // try follow redirects (some shares give short links)
    let permalink = url0;
    try{
      if (permalink && !/instagram\.com/i.test(permalink)){
        const r = await fetchWithTimeout(permalink, { redirect: 'follow' }, 12000);
        if (r?.url) permalink = r.url;
      }
    }catch(_){}

    let meta = null;
    if (mediaId) {
      try{
        // ✅ ВАЖНО: тут НЕ должно быть "..."
        meta = await igGraphGet(
          pageToken,
          mediaId,
          'media_type,caption,permalink,media_url,thumbnail_url,username,timestamp,children{media_type,media_url,thumbnail_url}'
        );
      }catch(_){
        meta = null;
      }
    }

    // fallback: oEmbed (needs IG_APP_ID|IG_APP_SECRET)
    let oe = null;
    if (!meta && permalink) oe = await igOembedGet(permalink);

    let caption = '';
    let author = '';
    let mediaType = '';
    let previewUrls = [];
    let videoUrl = '';

    if (meta) {
      mediaType = String(meta.media_type || '').toUpperCase();
      caption = String(meta.caption || '').trim();
      permalink = String(meta.permalink || permalink || '').trim();
      author = String(meta.username || '').trim();

      if (mediaType === 'CAROUSEL_ALBUM' && Array.isArray(meta.children?.data)) {
        previewUrls = meta.children.data
          .map(ch => String(ch?.thumbnail_url || ch?.media_url || '').trim())
          .filter(Boolean)
          .slice(0, 4);
      } else {
        const u = String(meta.thumbnail_url || meta.media_url || '').trim();
        if (u) previewUrls = [u];
      }

      if (mediaType === 'VIDEO') {
        videoUrl = String(meta.media_url || '').trim();
      }
    } else if (oe) {
      mediaType = 'SHARE';
      caption = String(oe.title || '').trim();
      author = String(oe.author_name || '').trim();
      const u = String(oe.thumbnail_url || '').trim();
      if (u) previewUrls = [u];
    } else {
      mediaType = 'SHARE';
    }

    const textCtx = [
      `[Пересланный контент Instagram]`,
      mediaType ? `Тип: ${mediaType}` : '',
      author ? `Автор: @${author.replace(/^@/,'')}` : '',
      caption ? `Подпись/текст: ${caption.slice(0, 1200)}` : '',
      permalink ? `Ссылка: ${permalink}` : '',
    ].filter(Boolean).join('\n');

    // build data-url previews (чтобы vision реально "видел")
    const previewDataUrls = [];
    for (const u of (previewUrls || []).slice(0, 4)) {
      let fp = '';
      try{
        const dl = await igDownloadToTmp(u, 'ig-share', '', 8 * 1024 * 1024);
        fp = dl.fp;
        const b = fs.readFileSync(fp);
        const m = dl.mime || 'image/jpeg';
        previewDataUrls.push(`data:${m};base64,${b.toString('base64')}`);
      }catch(_){
      }finally{
        try{ if (fp) fs.unlinkSync(fp); }catch(_){}
      }
    }

    return {
      textCtx,
      previewDataUrl: previewDataUrls[0] || '',
      previewDataUrls,
      videoUrl,
      mediaType,
      caption,
      permalink
    };
  }catch(e){
    return {
      textCtx: `[Пересланный контент Instagram]\nСсылка: ${String(att?.url||'').trim()}`,
      previewDataUrl: '',
      previewDataUrls: [],
      videoUrl: '',
      mediaType: 'SHARE',
      caption: '',
      permalink: String(att?.url||'').trim()
    };
  }
}

function igExtractIgPermalinkFromText(s){
  const t = String(s || '');

  // 1) редирект-линки вида l.instagram.com/?u=<encoded>
  const red = t.match(/https?:\/\/l\.instagram\.com\/\?u=([^&\s]+)/i);
  if (red && red[1]) {
    try {
      const decoded = decodeURIComponent(red[1]);
      const m2 = decoded.match(/https?:\/\/(?:www\.)?(?:instagram\.com|m\.instagram\.com)\/(p|reel|tv)\/[A-Za-z0-9_\-]+\/?/i);
      if (m2) return m2[0].split('?')[0];
    } catch (_) {}
  }

  // 2) обычные ссылки (www / m.)
  const m = t.match(/https?:\/\/(?:www\.)?(?:instagram\.com|m\.instagram\.com)\/(p|reel|tv)\/[A-Za-z0-9_\-]+\/?/i);
  if (m) return m[0].split('?')[0];

  // 3) без протокола: instagram.com/reel/xxx
  const m3 = t.match(/(?:^|\s)(?:www\.)?(instagram\.com|m\.instagram\.com)\/(p|reel|tv)\/[A-Za-z0-9_\-]+\/?/i);
  if (m3) {
    const raw = m3[0].trim();
    const withProto = raw.startsWith('http') ? raw : `https://${raw.replace(/^www\./i,'')}`;
    return withProto.split('?')[0];
  }

  return '';
}

function igExtractMediaId(rawJson){
  // rawJson у тебя иногда приходит как "change" (с value)
  const v = rawJson?.value || rawJson || {};
  return v.media_id || v.media?.id || v.id || '';
}

function igParseDmAttachments(ev){
  const atts = Array.isArray(ev?.message?.attachments) ? ev.message.attachments : [];
  return atts.map(a => {
    const type = String(a?.type || '').toLowerCase();
    // чаще всего payload.url (как в твоих логах)
    const url  = String(a?.payload?.url || a?.payload?.video_url || a?.payload?.audio_url || '').trim();
    return { type, url };
  }).filter(x => x.type);
}

async function igGetMediaContext(pageToken, source, rawJson, commentId){
  try{
    // комменты: попробуем взять caption поста
    if (source === 'comment' && commentId){
      const cm = await igGraphGet(pageToken, commentId, 'text,media{id,caption,media_type,permalink}');
      const caption = String(cm?.media?.caption || '').trim();
      const ctext   = String(cm?.text || '').trim();
      return [
        caption ? `Пост: ${caption}` : '',
        ctext ? `Комментарий: ${ctext}` : ''
      ].filter(Boolean).join('\n');
    }

    // mention_post: если это отметка в посте и есть commentId — вытаскиваем контекст через comment
    if (source === 'mention_post' && commentId){
      const cm = await igGraphGet(pageToken, commentId, 'text,from{id,username},media{id,caption,media_type,permalink}');
      const caption = String(cm?.media?.caption || '').trim();
      const ctext   = String(cm?.text || '').trim();
      const fromU   = String(cm?.from?.username || '').trim();
      const type    = String(cm?.media?.media_type || '').trim();
      const link    = String(cm?.media?.permalink || '').trim();

      let postText = caption;
      let postAuthor = '';

      if (!postText && link){
        const oe = await igOembedGet(link);
        const t = String(oe?.title || '').trim();
        const a = String(oe?.author_name || '').trim();
        if (t) postText = t;
        if (a) postAuthor = a;
      }

      return [
        postText ? `Пост${postAuthor ? ' (автор: ' + postAuthor + ')' : ''}: ${postText}` : '',
        ctext ? `Упоминание/комментарий${fromU ? ' от @' + fromU : ''}: ${ctext}` : '',
        type ? `Тип: ${type}` : '',
        link ? `Ссылка: ${link}` : ''
      ].filter(Boolean).join('\n');
    }

    // mentions: пробуем взять caption по media_id
    const mediaId = igExtractMediaId(rawJson);
    if (!mediaId) return '';

    const media = await igGraphGet(pageToken, mediaId, 'caption,media_type,permalink');
    const caption = String(media?.caption || '').trim();
    const type = String(media?.media_type || '').trim();
    const link = String(media?.permalink || '').trim();

    let postText = caption;
    let postAuthor = '';

    if (!postText && link) {
      const oe = await igOembedGet(link);
      const t = String(oe?.title || '').trim();
      const a = String(oe?.author_name || '').trim();
      if (t) postText = t;
      if (a) postAuthor = a;
    }

    return [
      postText ? `Контент${postAuthor ? ' (автор: ' + postAuthor + ')' : ''}: ${postText}` : '',
      type ? `Тип: ${type}` : '',
      link ? `Ссылка: ${link}` : ''
    ].filter(Boolean).join('\n');
  }catch(_){
    return '';
  }
}

async function igIsBlocked(tenantId, threadId){
  const jid = `ig:${threadId}`;
  const row = await get(`SELECT until FROM blocks WHERE tenant_id=? AND jid=?`, [tenantId, jid]);
  const now = Math.floor(Date.now()/1000);

  if (!row || !row.until) return false;
  if (Number(row.until) > now) return true;

  // истекло — чистим запись
  await run(`DELETE FROM blocks WHERE tenant_id=? AND jid=?`, [tenantId, jid]);
  return false;
}

async function igSetBlocked(tenantId, threadId, minutes){
  const jid = `ig:${threadId}`;

  // minutes <= 0 => снять блок
  if (!minutes || Number(minutes) <= 0) {
    await run(`DELETE FROM blocks WHERE tenant_id=? AND jid=?`, [tenantId, jid]);
    return;
  }

  const now = Math.floor(Date.now()/1000);
  const until = now + Math.floor(Number(minutes) * 60);

  await run(
    `INSERT INTO blocks(tenant_id, jid, until)
     VALUES(?,?,?)
     ON CONFLICT(tenant_id, jid) DO UPDATE SET until=excluded.until`,
    [tenantId, jid, until]
  );
}

async function igGetState(tenantId, threadId){
  let row = await get(
    `SELECT is_active FROM ig_chat_state WHERE tenant_id=? AND thread_id=?`,
    [tenantId, threadId]
  );
  if(!row){
    await run(
      `INSERT INTO ig_chat_state(tenant_id, thread_id, is_active, updated_at)
       VALUES (?,?,1,datetime('now'))`,
      [tenantId, threadId]
    );
    row = { is_active: 1 };
  }
  return row;
}

async function igSetActive(tenantId, threadId, active){
  await run(
    `INSERT INTO ig_chat_state(tenant_id, thread_id, is_active, updated_at)
     VALUES (?,?,?,datetime('now'))
     ON CONFLICT(tenant_id, thread_id)
     DO UPDATE SET is_active=excluded.is_active, updated_at=datetime('now')`,
    [tenantId, threadId, active ? 1 : 0]
  );
}

// === Instagram: create/sync a real account row in `accounts` (kind='ig') ===
// Used to have a "virtual" IG account (acc_id = -tenant_id). We still support it,
// but we prefer a real acc_id so UI/CRM integrations work consistently.
async function igGetOrCreateAccId(tenantId){
  const tid = Number(tenantId||0);
  if (!tid) return -tid;

  // already exists?
  const ex = await get(
    `SELECT id FROM accounts WHERE tenant_id=? AND (kind='ig' OR lower(kind)='instagram') ORDER BY id LIMIT 1`,
    [tid]
  );
  if (ex?.id) return Number(ex.id);

  // create from connection username (if any)
  const conn = await get(`SELECT username FROM ig_connections WHERE tenant_id=?`, [tid]);
  const uname = String(conn?.username||'').trim();
  const label = uname ? `@${uname}` : 'Instagram';

  const now = Date.now();
  const ins = await run(
    `INSERT INTO accounts(tenant_id, kind, label, status, folder, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [tid, 'ig', label, 'online', null, now, now]
  );
  return Number(ins?.lastID||0) || -tid;
}

async function igSyncAccountFromConn(tenantId){
  const tid = Number(tenantId||0);
  if (!tid) return null;

  const conn = await get(`SELECT username, status FROM ig_connections WHERE tenant_id=?`, [tid]);
  const acc = await get(
    `SELECT id FROM accounts WHERE tenant_id=? AND (kind='ig' OR lower(kind)='instagram') ORDER BY id LIMIT 1`,
    [tid]
  );

  // if not connected: mark existing IG account offline (do not create a new one)
  if (!conn){
    if (acc?.id){
      await run(`UPDATE accounts SET status='offline', updated_at=? WHERE id=?`, [Date.now(), Number(acc.id)]);
      return Number(acc.id);
    }
    return null;
  }

  const accId = acc?.id ? Number(acc.id) : await igGetOrCreateAccId(tid);
  const uname = String(conn?.username||'').trim();
  const label = uname ? `@${uname}` : 'Instagram';

  // treat everything except explicit "error" as online
  const st = (String(conn?.status||'').toLowerCase() === 'error') ? 'offline' : 'online';

  await run(
    `UPDATE accounts SET label=?, status=?, updated_at=? WHERE id=?`,
    [label, st, Date.now(), accId]
  );

  // migrate old virtual IG profiles (acc_id = -tenant_id) to the real acc_id
  try{
    await run(`UPDATE profiles SET acc_id=? WHERE tenant_id=? AND acc_id=? AND jid LIKE 'ig:%'`, [accId, tid, -tid]);
  }catch(_){ }

  return accId;
}

async function igTouchProfile(tenantId, threadId, username){
  const tid = Number(tenantId||0);
  const th  = String(threadId||'').trim();
  if (!tid || !th) return;

  // real IG acc_id (for UI/CRM)
  const accId = await igGetOrCreateAccId(tid);
  const jid = `ig:${th}`;
  const name = String(username||'').trim();

  const now = nowSec ? nowSec() : Math.floor(Date.now()/1000);

  await run(
    `INSERT INTO profiles(tenant_id, acc_id, jid, name, stage, slots_updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, acc_id, jid)
     DO UPDATE SET
       name = CASE WHEN excluded.name IS NOT NULL AND excluded.name <> '' THEN excluded.name ELSE profiles.name END,
       stage = CASE WHEN (profiles.stage IS NULL OR profiles.stage='') THEN excluded.stage ELSE profiles.stage END,
       slots_updated_at = excluded.slots_updated_at`,
    [tid, accId, jid, name, 'unknown', now]
  );
}

async function igHandleInbound({
  tenantId,
  pageToken,
  source,     // 'dm' | 'comment' | 'mention_story' | 'mention_post'
  threadId,
  senderId,
  username='',
  text='',
  rawJson=null,
  mediaId=null,
  igUserId=null,
  attachments=null,
  commentId=null
}){

  // разрешения по типу события
  const allowDirect = (await getSetting('ig_allow_direct', tenantId)) !== '0';
  const allowComm   = (await getSetting('ig_allow_comments', tenantId)) !== '0';
  const allowCommDM  = (await getSetting('ig_allow_comment_dm', tenantId)) === '1';
  const allowStory  = (await getSetting('ig_allow_story_mentions', tenantId)) !== '0';
  const allowPost   = (await getSetting('ig_allow_post_mentions', tenantId)) !== '0';

  console.log('[IG INBOUND]', {
    tenantId, source,
    allowDirect, allowComm, allowCommDM, allowStory, allowPost,
    threadId, senderId,
    text: String(text||'').slice(0,80)
  });

  if (source === 'dm' && !allowDirect) return;
  if (source === 'comment' && !allowComm && !allowCommDM) return;
  if (source === 'mention_story' && !allowStory) return;
  if (source === 'mention_post' && !allowPost) return;

  // общий тумблер IG (управляется из "Аккаунты")
  const igEnabled = (await getSetting('ig_enabled', tenantId)) !== '0';
  if (!igEnabled) return;

  // use real IG account id (stable for CRM/UI)
  const igAccId = await igGetOrCreateAccId(tenantId);

  // стоп-лист
  const stopRaw = String(await getSetting('ig_stoplist', tenantId) || '');
  let uname = String(username || '').trim();

  // если в стоп-листе есть @... и username пустой — пробуем подтянуть
  if (!uname && stopRaw.includes('@')){
    uname = await igResolveUsername(pageToken, senderId);
  }

  const stopList = parseStopList(stopRaw);
  if (inStopList(stopList, senderId, uname)) { console.log('[IG] stoplist hit', { tenantId, senderId, username: uname }); return; }

  // блокировка (мин) — используется ТОЛЬКО для stopword (на N минут)
  const blockMin = Math.max(0, Math.min(1440, Number(await getSetting('ig_block_time_min', tenantId) || 0)));

  const msgLower = String(text||'').toLowerCase();

  // stop/start логика — только для DM
  if (source === 'dm'){
    console.log('[IG DM] enter', { tenantId, threadId, senderId, text: String(text||'').slice(0,80) });
    const stopWord  = String(await getSetting('ig_stopword', tenantId) || '').trim().toLowerCase();
    const startWord = String(await getSetting('ig_startword', tenantId) || '').trim().toLowerCase();

    // START: снимаем блокировку и (на всякий) включаем чат, но НЕ отвечаем на команду
    if (startWord && msgLower.includes(startWord)) {
      await igSetBlocked(tenantId, threadId, 0);
      await igSetActive(tenantId, threadId, true);
      return;
    }

    if (await igIsBlocked(tenantId, threadId)) { console.log('[IG DM] blocked', { tenantId, threadId }); return; }

    // Если сейчас заблокировано — молчим (до окончания времени), пока не пришло startWord
    if (await igIsBlocked(tenantId, threadId)) return;

    // STOP: если blockMin задан — выключаем на N минут через blocks
    // если blockMin = 0 — выключаем “вручную” через is_active (до startWord)
    if (stopWord && msgLower.includes(stopWord)) {
      if (blockMin > 0) {
        await igSetBlocked(tenantId, threadId, blockMin);
      } else {
        await igSetActive(tenantId, threadId, false);
      }
      return;
    }

    // Если чат выключен вручную — молчим (до startWord)
    const st = await igGetState(tenantId, threadId);
    if (Number(st?.is_active || 0) !== 1) { console.log('[IG DM] inactive', { tenantId, threadId, is_active: st?.is_active }); return; }
  }

  // логируем вход
  await run(
    `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
     VALUES(?,?,?,?,?,?,?)`,
    [tenantId, threadId, senderId, Date.now(), 'in', String(text||''), JSON.stringify(rawJson||{}).slice(0, 200000)]
  );

  // ➜ делаем/обновляем профиль для chat.html
  if (source === 'dm' || source === 'comment' || source === 'mention_story' || source === 'mention_post') {
    await igTouchProfile(tenantId, threadId, String(username||'').trim());
  }

  // ➜ ЛИД + таймлайн в CRM (Instagram)
  try {
    await pushLeadToCRM({
      tenant_id: tenantId,
      acc_id: igAccId,
      jid: `ig:${threadId}`,
      phone: '',
      last_message: String(text||''),
      wa_display_name: String(username||'').trim(),
      username: String(username||'').trim().replace(/^@/, '')
    });
  } catch (e) {
    console.warn('[IG][CRM] lead push fail:', e?.message || e);
  }
  try {
    await pushMessageToCRM({
      tenant_id: tenantId,
      acc_id: igAccId,
      jid: `ig:${threadId}`,
      direction: 'in',
      text: String(text||''),
      media_file: '',
      media_kind: '',
      external_id: `ig:${tenantId}:${threadId}:${Date.now()}`,
      username: String(username||'').trim()
    });
  } catch (e) {
    console.warn('[IG][CRM] timeline push fail:', e?.message || e);
  }

  // ➜ realtime для chat.html: поднять чат наверх (room у тебя tenant_${tid})
  try{
    const date = new Date().toISOString().slice(0,10);
    io.to(`tenant_${tenantId}`).emit('newchat',{
      acc_id: igAccId,
      jid: `ig:${threadId}`,
      phone: String(threadId),
      text: String(text||''),
      date
    });
  }catch(_){}

  // задержка ответа
  const delaySec = Math.max(0, Math.min(600, Number(await getSetting('ig_delay_sec', tenantId) || 0)));
  if (delaySec > 0) await new Promise(r => setTimeout(r, delaySec * 1000));

  // promptText должен существовать ДО любых promptText +=
  let promptText = String(text || '');

  // --- DM media policy: ai | template | ignore ---
  // default = 'ai' (старое поведение). Для твоего случая поставим в settings: template
  const dmMediaAction = (source === 'dm')
    ? String(await getSetting('ig_dm_media_action', tenantId) || 'ai').trim().toLowerCase()
    : 'ai';

  if (source === 'dm') {
    const atts = Array.isArray(attachments) ? attachments : [];

    // Вложения добавляем в prompt только если реально идём в AI
    if (dmMediaAction === 'ai') {
      if (atts.length > 0) {
        const list = atts.map(a => `- ${a.type}${a.url ? `: ${a.url}` : ''}`).join('\n');
        promptText += `\n\n[Вложения]\n${list}\n\n` +
          `Если текста нет — всё равно помоги: сделай разбор по контенту и задай 1-2 уточняющих вопроса.`;
      }
    }

    const hasMedia = atts.some(a => {
      const t = String(a?.type || '').toLowerCase();
      return t && t !== 'story_mention';
    });
    const hasText = String(text || '').trim().length > 0;

    if (hasMedia && !hasText && dmMediaAction !== 'ai') {
      if (dmMediaAction === 'ignore') return;

      const fallback =
        String(await getSetting('ig_media_fallback_text', tenantId) || '').trim()
        || 'Кешіріңіз, аудио/фото/видео өңдей алмаймын. Сұрағыңызды мәтінмен жазыңыз 🙂';

      try { await igSendLongText(pageToken, senderId, fallback); }
      catch (e) { console.warn('[IG SEND] fail:', e?.message || e); }

      await run(
        `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
        VALUES(?,?,?,?,?,?,?)`,
        [tenantId, threadId, 'me', Date.now(), 'out', fallback,
        JSON.stringify({ source, reason: 'media_fallback' }).slice(0, 200000)]
      );

      return;
    }
  }

  // AI ответ
  let reply = '';
  try{
    // для комментариев и отметок слегка уточняем, что это не DM
    promptText = String(text||'');
    
    const atts = Array.isArray(attachments) ? attachments : [];
    if (atts.length > 0) {
      const list = atts.map(a => `- ${a.type}${a.url ? `: ${a.url}` : ''}`).join('\n');
      promptText += `\n\n[Вложения]\n${list}\n\n` +
        `Если текста нет — всё равно помоги: сделай разбор по контенту и задай 1-2 уточняющих вопроса.`;
    }

    if (source === 'comment') promptText = `Комментарий под постом: ${promptText}`;
    if (source === 'mention_story') promptText = `Пользователь отметил в сторис. Текст/описание: ${promptText}`;
    if (source === 'mention_post') {
      promptText =
        `Пользователь упомянул наш аккаунт в комментариях под постом (возможно чужим). ` +
        `Ответь по смыслу поста и комментария, без лишнего приветствия. ` +
        `Если контекста недостаточно — задай 1 короткий уточняющий вопрос.\n` +
        `Текст комментария: ${promptText}`;
    }

    const mediaCtx = await igGetMediaContext(pageToken, source, rawJson, commentId);
    if (mediaCtx){
      promptText += `\n\n[Контекст поста/сторис]\n${mediaCtx}`;
    }

    // ✅ Добавляем вложения (reel/post/share) в текст для Marketing AI
    if (source === 'dm' && rawJson) {
      try{
        const atts = igDmAttachmentsFromEvent(rawJson) || [];
        if (atts.length) {
          const lines = atts.map(a => {
            const t = a.type || 'attachment';
            const u = a.url ? ` ${a.url}` : '';
            const title = a.title ? ` (${a.title})` : '';
            return `- ${t}${u}${title}`;
          }).join('\n');
          promptText += `\n\n[Вложения]\n${lines}`;
        }
      }catch(_){}
    }

    // --- DM media handling (image/audio/video) ---
    let userContent = promptText;
    let modelOverride = null;

    // Нормализуем аттач: иногда прилетает payload.url, иногда share c title+url
    if (dmMediaAction === 'ai' && source === 'dm' && rawJson) {
      const atts = igDmAttachmentsFromEvent(rawJson) || [];
      const a0 = atts[0] || null;

      const a0n = {
        type: a0?.type || 'attachment',
        url:  String(a0?.url || '').trim(),
        title: String(a0?.title || '').trim(),
        mime: String(a0?.mime || '').trim(),
        media_id: String(a0?.media_id || '').trim()
      };

      // если юзер прислал просто ссылку текстом (без attachments) — тоже считаем это share
      if (!a0n.url) {
        const uTxt = igExtractIgPermalinkFromText(promptText);
        if (uTxt) a0n.url = uTxt;
      }

      // Иногда type приходит как "share/attachment", но mime = video/mp4
      const inferredType = (() => {
        const t = String(a0n.type || '').toLowerCase();
        const m = String(a0n.mime || '').toLowerCase();
        const u = String(a0n.url || '');

        // 1) mime — самый надежный
        if (m.startsWith('image/')) return 'image';
        if (m.startsWith('video/')) return 'video';
        if (m.startsWith('audio/')) return 'audio';

        // 2) сигнатуры по URL
        if (/\/reel\//i.test(u) || /\.mp4($|\?)/i.test(u)) return 'video';

        // 3) явные типы
        if (t === 'image' || t === 'video' || t === 'audio' || t === 'share') return t;

        return t || 'attachment';
      })();

        // 1) Если это "share" и url нет — пробуем достать через HEAD (Location)
        if (!a0n.url && a0?.payload?.url) a0n.url = a0.payload.url;

        // 2) SHARE (пост/рилс): подтягиваем подпись + превью, чтобы AI НЕ писал "не могу просмотреть ссылку"
        const looksLikeShare =
          inferredType === 'share' ||
          !!String(a0n.media_id || '').trim() ||
          /instagram\.com\/(p|reel|tv)\//i.test(String(a0n.url||''));

          if (looksLikeShare && (a0n.url || a0n.media_id)) {

            let sh = null;
            try {
              sh = await igResolveShareForMarketing(pageToken, a0n);
            } catch (e) {
              console.warn('[IG SHARE] resolve fail:', e?.message || e);
              sh = null;
            }

            modelOverride = 'gpt-4o';

            // попробуем для видео вытащить 1 кадр + речь (если получится)
            let shareTranscript = '';
            let shareFrameDataUrl = '';

            if (sh.videoUrl) {
              let vfp = '';
              let afp = '';
              let ffp = '';
              try{
                const dlv = await igDownloadToTmp(sh.videoUrl, 'ig-share-video', 'video/mp4', 35 * 1024 * 1024);
                vfp = dlv.fp;

                // транскрипция
                try{
                  afp = await igExtractAudioFromVideo(vfp);
                  if (afp) shareTranscript = await igTranscribeLocalFile(tenantId, afp);
                }catch(_){}

                // 1 кадр
                try{
                  ffp = await videoFirstFrameToJpg(vfp);
                  if (ffp) {
                    const b = fs.readFileSync(ffp);
                    shareFrameDataUrl = `data:image/jpeg;base64,${b.toString('base64')}`;
                  }
                }catch(_){}
              }catch(e){
                console.warn('[IG SHARE] video fetch/extract fail:', e?.message || e);
              }finally{
                try{ if (vfp) fs.unlinkSync(vfp); }catch(_){}
                try{ if (afp) fs.unlinkSync(afp); }catch(_){}
                try{ if (ffp) fs.unlinkSync(ffp); }catch(_){}
              }
            }

            const baseText =
              `${promptText}\n\n${sh?.textCtx || ''}\n\n(Если контент не подтянулся полностью — всё равно сделай разбор по тому, что есть, и задай 1 уточняющий вопрос.)` +
              (shareTranscript ? `\n\n[Речь/аудио из видео (распознано)]:\n${shareTranscript}` : '')

            const parts = [{ type: 'text', text: baseText }];

            // сначала кадр из видео, потом превью/карусель
            const imgs = [];
            if (shareFrameDataUrl) imgs.push(shareFrameDataUrl);
            if (Array.isArray(sh.previewDataUrls)) imgs.push(...sh.previewDataUrls);

            for (const u of imgs.filter(Boolean).slice(0, 4)) {
              parts.push({ type: 'image_url', image_url: { url: u } });
            }

            userContent = (parts.length > 1) ? parts : baseText;
          }

        // 2) Фото: скачиваем и шлём в vision как data-url (так OpenAI точно увидит картинку)
        if (!Array.isArray(userContent) && a0 && inferredType === 'image' && a0n.url) {
          modelOverride = 'gpt-4o';

          let fp = '';
          let dataUrl = '';
          try{
            const dl = await igDownloadToTmp(a0.url, 'ig-img', a0.mime || '');
            fp = dl.fp;

            const b = fs.readFileSync(fp);
            const mime = dl.mime || 'image/jpeg';
            dataUrl = `data:${mime};base64,${b.toString('base64')}`;
          }catch(e){
            console.warn('[IG DM] image download failed:', e?.message || e);
          }finally{
            try{ if (fp) fs.unlinkSync(fp); }catch(_){}
          }

          if (dataUrl){
            userContent = [
              { type: 'text', text: `${promptText}\n\n[Пользователь прислал фото. Проанализируй изображение и ответь по нему.]` },
              { type: 'image_url', image_url: { url: dataUrl } }
            ];
          }else{
            // fallback (без падений)
            userContent = `${promptText}\n\n[Пользователь прислал фото, но оно не скачалось. Попроси 1 уточняющий вопрос: что на фото?]`;
          }
        }

        // 3) Аудио/видео: скачиваем (теперь будет mp4/m4a/mp3), транскрибируем
        if (!Array.isArray(userContent) && a0 && (inferredType === 'audio' || inferredType === 'video') && a0n.url) {
          let fp = '';
          let audioFp = '';
          let frameFp = '';
          let transcript = '';
          let frameDataUrl = '';

          try {
            const dl = await igDownloadToTmp(a0n.url, inferredType === 'audio' ? 'ig-audio' : 'ig-video', a0n.mime || '');
            fp = dl.fp;

            // 1) транскрипция (если получится)
            try {
              if (inferredType === 'video') {
                audioFp = await igExtractAudioFromVideo(fp);
                if (audioFp) transcript = await igTranscribeLocalFile(tenantId, audioFp);
              } else {
                transcript = await igTranscribeLocalFile(tenantId, fp);
              }
            } catch (e) {
              console.warn('[IG DM] transcribe failed:', e?.message || e);
            }

            // 2) если это видео — достанем 1й кадр и отправим в vision
            if (inferredType === 'video') {
              try {
                frameFp = await videoFirstFrameToJpg(fp);
                if (frameFp) {
                  const b = fs.readFileSync(frameFp);
                  frameDataUrl = `data:image/jpeg;base64,${b.toString('base64')}`;
                }
              } catch (e) {
                console.warn('[IG DM] frame extract failed:', e?.message || e);
              }
            }

          } finally {
            try { if (audioFp) fs.unlinkSync(audioFp); } catch (_) {}
            try { if (frameFp) fs.unlinkSync(frameFp); } catch (_) {}
            try { if (fp) fs.unlinkSync(fp); } catch (_) {}
          }

          const t = transcript ? `Распознанная речь/звук:\n${transcript}` : 'Речь не распознана (или её нет).';

          if (inferredType === 'video' && frameDataUrl) {
            modelOverride = 'gpt-4o';
            userContent = [
              { type: 'text', text: `${promptText}\n\n[Пользователь прислал ВИДЕО.]\n\n${t}` },
              { type: 'image_url', image_url: { url: frameDataUrl } }
            ];
          } else {
            // аудио или видео без кадра — всё равно отвечаем без отказа
            userContent = `${promptText}\n\n[Пользователь прислал ${inferredType === 'audio' ? 'АУДИО' : 'ВИДЕО'}.]\n\n${t}\n\nЕсли данных мало — НЕ отказывай. Дай полезный разбор и задай 1 уточняющий вопрос.`;
          }
        }
      }

    const modelToUse = modelOverride || (Array.isArray(userContent) ? 'gpt-4o' : 'gpt-4o-mini');

      reply = await igMakeAIReply(tenantId, threadId, userContent, { model: modelToUse });

  }catch(e){
    console.warn('[IG AI] fail:', e?.message || e);
    return;
  }
  if (!reply) return;

  // отправка по каналу
  try{
  if (source === 'mention_post' && (commentId || mediaId) && igUserId) {
    // правильный путь для @mentions
    await igReplyToMention(pageToken, igUserId, { commentId, mediaId }, reply);

  } else if ((source === 'comment' || source === 'mention_post') && commentId){
    
    await igReplyToComment(pageToken, commentId, reply);

    // ✅ Если включен тумблер — дополнительно пишем комментатору в Direct (Private Reply)
    if (source === 'comment' && allowCommDM) {
      try {
        console.log('[IG COMMENT DM] sending', { tenantId, commentId });
        await igSendPrivateReplyToComment(pageToken, commentId, reply);
        console.log('[IG COMMENT DM] ok', { tenantId, commentId });
      } catch (e) {
        console.warn('[IG COMMENT DM] fail:', e?.message || e);
      }
    }
  
  } else {
    await igSendLongText(pageToken, senderId, reply);
  }

  }catch(e){
    console.warn('[IG SEND] fail:', e?.message || e);
    return;
  }

  // логируем исходящее
  await run(
    `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
     VALUES(?,?,?,?,?,?,?)`,
    [tenantId, threadId, 'me', Date.now(), 'out', reply, JSON.stringify({ source }).slice(0, 200000)]
  );

}

async function igFindConnByIds(ids){
  const uniq = Array.from(new Set(
    (Array.isArray(ids)?ids:[])
      .map(x => String(x||'').trim())
      .filter(Boolean)
  ));
  if (!uniq.length) return null;

  const ph = uniq.map(()=>'?').join(',');
  const sql = `
    SELECT tenant_id, access_token, page_id, ig_user_id, username
    FROM ig_connections
    WHERE page_id IN (${ph}) OR ig_user_id IN (${ph})
    ORDER BY connected_at DESC
    LIMIT 1
  `;
  return get(sql, [...uniq, ...uniq]);
}

// Webhook receive
app.post('/webhook/ig', async (req, res) => {
  // ВАЖНО: отвечаем сразу, чтобы Meta не ретраила
  try { res.sendStatus(200); } catch (_) {}

  try {
    const body = req.body || {};
    console.log('[IG WEBHOOK] incoming:', JSON.stringify(body).slice(0, 2000));

    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
      const entryId = String(entry?.id || ''); // часто ig_user_id
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];

      for (const ev of messaging) {
        // каждое событие обрабатываем отдельно (чтобы одно не ломало остальные)
        try {
          const senderId = String(ev?.sender?.id || '');
          const recipientId = String(ev?.recipient?.id || '');

          const isEcho = !!ev?.message?.is_echo;

          // Если это сообщение отправили МЫ (менеджер от привязанного аккаунта)
          // то AI не отвечаем, но стоп/старт-команды должны работать
          if (isEcho) {
            const textEcho = String(ev?.message?.text || '').trim();
            if (textEcho) {
              // tenant по entryId + senderId (в echo senderId = наша страница/акк)
              const rowEcho = await igFindConnByIds([entryId, senderId]);
              const tenantEcho = Number(rowEcho?.tenant_id || 0);
              const tokenEcho  = String(rowEcho?.access_token || '');
              if (tenantEcho && tokenEcho) {
                const stopWord  = String(await getSetting('ig_stopword', tenantEcho) || '').trim().toLowerCase();
                const startWord = String(await getSetting('ig_startword', tenantEcho) || '').trim().toLowerCase();
                const blockMin  = Math.max(0, Math.min(1440, Number(await getSetting('ig_block_time_min', tenantEcho) || 0)));

                // В echo recipientId = клиент, значит threadId должен быть recipientId
                const threadIdEcho = String(recipientId || '').trim();
                const low = textEcho.toLowerCase();

                if (threadIdEcho) {
                  if (startWord && low.includes(startWord)) {
                    await igSetBlocked(tenantEcho, threadIdEcho, 0);
                    await igSetActive(tenantEcho, threadIdEcho, true);
                  } else if (stopWord && low.includes(stopWord)) {
                    if (blockMin > 0) await igSetBlocked(tenantEcho, threadIdEcho, blockMin);
                    else await igSetActive(tenantEcho, threadIdEcho, false);
                  }
                }
              }
            }
            continue; // важно: эхо дальше не обрабатываем (чтобы не было петель)
          }

          // dedup по уникальному message.mid (IG иногда шлет одно и то же 2 раза)
          const mid = String(ev?.message?.mid || '').trim();
          if (mid && igSeenRecently(`ig:dm:${mid}`)) continue;
          
          if (!senderId) continue;
          if (senderId === recipientId || senderId === entryId) continue;

          let source = 'dm';
          let text = String(ev?.message?.text || '').trim();

          // story mention приходит как attachment type=story_mention (текста может не быть)
          const dmAtts = igParseDmAttachments(ev);

          if (!text) {
            const t0 = String(dmAtts?.[0]?.type || '').toLowerCase();

            if (t0 === 'story_mention') {
              source = 'mention_story';
              text =
                'Пользователь отметил наш аккаунт в Instagram Stories. ' +
                'Нужно ответить пользователю в Direct кратко и дружелюбно, ' +
                'без объяснений что такое сторис/упоминание. ' +
                'Если непонятно, что именно на сторис — задай 1 короткий уточняющий вопрос.';
            } else if (dmAtts.length > 0) {
              // есть вложения, но нет текста — оставляем text пустым
              text = '';
            } else {
              // нет текста и нет вложений — игнорируем (это может быть не сообщение)
              continue;
            }

          }

          const threadId = senderId; // DM thread = sender

          const msgLower = text.toLowerCase();

          // 1) определяем tenant по page_id (recipient) или ig_user_id (entryId)
          const row = await igFindConnByIds([entryId, recipientId]);

          const tenantId = Number(row?.tenant_id || 0);
          if (!tenantId) {
            console.warn('[IG WEBHOOK] tenant not found for page_id=%s entryId=%s', recipientId, entryId);
            continue;
          }

          const pageToken = String(row?.access_token || '');
          if (!pageToken) {
            console.warn('[IG WEBHOOK] missing page token tenant=%s', tenantId);
            continue;
          }

          const username = await igResolveUsername(pageToken, senderId);

          await igHandleInbound({
            tenantId,
            pageToken,
            source,      // <-- вот так
            threadId,
            senderId,
            username,
            text,
            attachments: dmAtts,
            rawJson: ev
          });

          continue; // важно: чтобы ниже не шёл старый дубль-обработчик DM

          // 2) включен ли IG агент
          const igEnabled = (await getSetting('ig_enabled', tenantId)) === '1';
          if (!igEnabled) continue;

          // 3) state + stop/start
          const stopWord  = String(await getSetting('ig_stopword', tenantId) || '').trim().toLowerCase();
          const startWord = String(await getSetting('ig_startword', tenantId) || '').trim().toLowerCase();

          const st = await igGetState(tenantId, threadId);

          // STOP: выключаем чат и молчим
          if (stopWord && msgLower.includes(stopWord)) {
            await igSetActive(tenantId, threadId, false);
            continue;
          }

          // START: если есть слово запуска — чат молчит пока не пришло startWord
          if (startWord) {
            if (msgLower.includes(startWord)) {
              await igSetActive(tenantId, threadId, true);
              // можно не отвечать на слово запуска
              continue;
            }
            if (Number(st?.is_active || 0) !== 1) {
              continue;
            }
          } else {
            // если startWord НЕ задан — просто проверяем активность
            if (Number(st?.is_active || 0) !== 1) continue;
          }

          console.log('[IG WEBHOOK] tid=%s sender=%s recipient=%s text=%s',
            tenantId, senderId, recipientId, text.slice(0, 200)
          );

          // 4) сохраняем входящее (таблица ig_chats у тебя именно такая)
          await run(
            `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
             VALUES(?,?,?,?,?,?,?)`,
            [tenantId, threadId, senderId, Date.now(), 'in', text, JSON.stringify(ev).slice(0, 200000)]
          );

          // 4.1) тумблер ИИ в разделе "Аккаунты" (accounts.ai_enabled для IG)
          const igAcc = await get(
            `SELECT ai_enabled FROM accounts
             WHERE tenant_id=? AND (kind='ig' OR kind='instagram')
             ORDER BY id DESC LIMIT 1`,
            [tenantId]
          );
          if (igAcc && Number(igAcc.ai_enabled) === 0) {
            continue; // ИИ для Instagram выключен тумблером — не отвечаем
          }

          // 5) задержка
          const delaySec = Math.max(0, Math.min(600, Number(await getSetting('ig_delay_sec', tenantId) || 0)));
          if (delaySec > 0) await new Promise(r => setTimeout(r, delaySec * 1000));

          // 6) AI ответ (в try/catch чтобы никогда не валить вебхук)
          let reply = '';
          try {
            const ent = await getTenantEntitlements(tenantId);

            reply = await igMakeAIReply(tenantId, threadId, text);


          } catch (e) {
            console.warn('[IG AI] fail:', e?.message || e);
            reply = '';
          }

          if (!reply) continue;

          // 7) отправка
          try {
            await igSendLongText(pageToken, senderId, reply);
          } catch (e) {
            console.warn('[IG SEND] fail:', e?.message || e);
            // если отправка упала — всё равно логируем исходящее в БД необязательно
            continue;
          }

          // 8) сохраняем исходящее
          await run(
            `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
            VALUES(?,?,?,?,?,?,?)`,
            [tenantId, threadId, recipientId, Date.now(), 'out', reply, JSON.stringify({ out: 1 }).slice(0, 200000)]
          );

        } catch (e) {
          console.error('[IG WEBHOOK] event error:', e);
          // не падаем на одном событии
          continue;
        }
      }

      // --- Comments / Mentions come via entry.changes ---
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const ch of changes){
        try{
          const field = String(ch?.field || '').toLowerCase();
          const v = ch?.value || {};

          const conn = await igFindConnByIds([
            entryId,
            v?.page_id,
            v?.page?.id,
            v?.instagram_business_account?.id
          ]);

          const tenantId = Number(conn?.tenant_id || 0);
          const pageToken = String(conn?.access_token || '');

          if (!tenantId || !pageToken) {
            console.warn('[IG changes] conn not found entryId=%s field=%s', entryId, field);
            continue;
          }

          const text = String(v?.text || v?.message || '').trim();
          const fromId = String(v?.from?.id || v?.sender_id || '').trim();
          const username = String(v?.from?.username || v?.from?.name || '').trim();

          // 0) игнорим свои же комменты/упоминания, иначе будет бесконечная петля
          const selfIgId = String(conn?.ig_user_id || '').trim();
          const selfPageId = String(conn?.page_id || '').trim();
          const selfU = String(conn?.username || '').trim().replace(/^@/, '').toLowerCase();
          const u = String(username || '').trim().replace(/^@/, '').toLowerCase();

          if (fromId && (fromId === selfIgId || fromId === selfPageId || fromId === entryId)) {
            continue;
          }
          if (u && selfU && u === selfU) {
            continue;
          }

          // комментарии
          if (field.includes('comment')){
            const commentId = String(v?.id || v?.comment_id || '').trim();
            if (!commentId || !fromId) continue;

            // dedup: IG может прислать один и тот же comment webhook несколько раз
            if (igSeenRecently(`ig:comment:${commentId}`, 30 * 60 * 1000)) continue;

            const mediaId = String(v?.media?.id || v?.media_id || '').trim();
            const threadId = `c:${fromId}:${mediaId || '0'}`;

            await igHandleInbound({
              tenantId,
              pageToken,
              source: 'comment',
              threadId,
              senderId: fromId,
              username,
              text: text || '(комментарий)',
              rawJson: ch,
              commentId
            });
            continue;
          }

          // mentions (story/post) — у Meta может называться по-разному, ловим широко
          if (field.includes('mention')){
            const commentId = String(v?.comment_id || '').trim();
            let mediaId = String(v?.media?.id || v?.media_id || '').trim();

            const mKey = `ig:mention:${commentId || mediaId || '0'}:${fromId || '0'}`;
            if (igSeenRecently(mKey, 30 * 60 * 1000)) continue;

            // иногда fromId не приходит — если есть commentId, попробуем дотянуть автора коммента
            let fromId2 = String(fromId || '').trim();
            let username2 = String(username || '').trim();
            let text2 = String(text || '').trim();

            if (!fromId2 && commentId) {
              try{
                const cm = await igGraphGet(pageToken, commentId, 'text,from{id,username},media{id}');
                fromId2 = String(cm?.from?.id || '').trim();
                username2 = String(cm?.from?.username || '').trim();
                if (!text2) text2 = String(cm?.text || '').trim();

                // ВАЖНО: дотягиваем mediaId, если его не было в webhook
                if (!mediaId) mediaId = String(cm?.media?.id || '').trim();
              }catch(_){}
            }

            // 0.1) после догрузки автора — снова проверяем, не мы ли это (иначе будет петля)
            const u2 = String(username2 || '').trim().replace(/^@/, '').toLowerCase();

            if (fromId2 && (fromId2 === selfIgId || fromId2 === selfPageId || fromId2 === entryId)) {
              continue;
            }
            if (u2 && selfU && u2 === selfU) {
              continue;
            }

            // mentions endpoint требует media_id всегда
            if (!mediaId) {
              console.warn('[IG mention] skip: missing mediaId. commentId=%s raw=%s', commentId, JSON.stringify(v).slice(0,300));
              continue;
            }

            // если вообще нет точек для ответа — выходим
            if (!commentId && !mediaId) continue;

            const threadId = commentId ? `mcom:${commentId}` : `mmedia:${mediaId}`;
            await igHandleInbound({
              tenantId,
              pageToken,
              source: 'mention_post',
              threadId,
              senderId: fromId2 || '0',
              username: username2,
              text: text2 || '(упоминание)',
              rawJson: ch,
              igUserId: selfIgId,
              mediaId,
              commentId
            });

            continue;
          }

        }catch(e){
          console.warn('[IG changes] one change fail:', e?.message||e);
        }
      }

    }
  } catch (e) {
    console.error('[IG WEBHOOK] fatal:', e);
  }
});

// -------------------------------------------------
// API: Settings / Followup / Telegram
// -------------------------------------------------
app.get('/api/settings', authGuard, async (req,res)=>{
  const rows = await all(`SELECT key,value FROM settings WHERE tenant_id=?`, [req.user.tenant_id]);
  const out  = {};
  rows.forEach(r => {
    if (r.key === 'openai_key') return; // скрываем ключ
    out[r.key] = r.value;
  });
  out.public_base_url = getPublicBaseUrl();  // ← всегда показываем константу
  res.json(out);
});

app.post('/api/settings', authGuard, async (req,res)=>{
  let body = req.body;

  // страховка: иногда прилетает двойной JSON строкой
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  if (body && typeof body === 'object' && typeof body.key === 'string' && body.key.startsWith('{"')) {
    try { body = JSON.parse(body.key); } catch {}
  }

  const { key, value } = body || {};

  console.log('[SETTINGS SAVE]', req.user.tenant_id, key, value);

  const ent = await getTenantEntitlements(req.user.tenant_id);
  const need = featureNeededForSettingKey(String(key||''));
  if(need && !maskHas(ent.feature_mask, need)){
    return res.status(403).json({ ok:false, error:'SETTING_DISABLED_BY_TARIFF' });
  }

  if (key === 'public_base_url') {
    // не ломаем сохранение остальных настроек
    return res.json({ ok:true, ignored:true });
  }
  if (key === 'openai_key') {
    return res.status(403).json({ ok:false, error:'openai_key is managed by server env (OPENAI_API_KEY)' });
  }
  await setSetting(key, value, req.user.tenant_id);
  res.json({ok:true});
});

app.get('/api/followup',
  authGuard,
  requireAnyFeature(FEATURES.FOLLOWUP_TEMPLATE | FEATURES.FOLLOWUP_AI),
  async (req,res)=>{

  const cfg = await loadFollowupConfig(req.user.tenant_id);
  // --- DEBUG ---
  console.log('[FU][GET] tid=%s -> enabled=%s steps=%o',
    req.user.tenant_id, cfg.enabled, cfg.steps);

  res.json({ enabled: cfg.enabled?1:0, steps: cfg.steps, allowed_stages: cfg.allowed_stages });
});

app.post('/api/followup',
  authGuard,
  requireAnyFeature(FEATURES.FOLLOWUP_TEMPLATE | FEATURES.FOLLOWUP_AI),
  async (req,res)=>{

  const enabled = req.body?.enabled ? '1' : '0';
  const raw = Array.isArray(req.body?.steps) ? req.body.steps : [];

  let allowed_stages = req.body?.allowed_stages;
  if (!Array.isArray(allowed_stages)) allowed_stages = [];

  const allowedSet = new Set(['unknown','human_needed','need_identified','booked','not_interested']);
  allowed_stages = allowed_stages
    .map(s=>String(s||'').toLowerCase().trim())
    .filter(s=>allowedSet.has(s));

  if (allowed_stages.length === 0) allowed_stages = ['unknown','human_needed'];

  // --- DEBUG: что прилетело с фронта
  console.log('[FU][POST][INCOMING] tid=%s enabled=%s raw=%o',
    req.user.tenant_id, enabled, raw);

  const steps = raw.slice(0,7).map(s => ({
    after_min: parseInt(s.after_min, 10) || 0,
    text: (s.text == null ? '' : String(s.text)),   
    media_file: (s.media_file||'').toString().trim(),
    media_kind: (()=>{
      const mk = String(s.media_kind || '').toLowerCase();
      return ['image','video','audio','video_note'].includes(mk) ? mk : '';
    })(),
    template_id: s.template_id ? parseInt(s.template_id, 10) : null,
    ai: !!s.ai,
    ai_style: (s.ai_style||'').toString()
  })).filter(s => s.after_min > 0 && (s.ai || s.text || s.media_file || s.template_id));

  // --- DEBUG: что мы собираемся сохранить
  console.log('[FU][POST][NORMALIZED] tid=%s steps=%o', req.user.tenant_id, steps);

  await setSetting('followup_enabled', enabled, req.user.tenant_id);

  const ent = req.entitlements || await getTenantEntitlements(req.user.tenant_id);
  for(const s of (steps||[])){
    const isAi = Number(s?.ai||0) === 1 || s?.type === 'ai';
    if(isAi && !ent.features.followup_ai){
      return res.status(403).json({ ok:false, error:'FOLLOWUP_AI_DISABLED' });
    }
    if(!isAi && !ent.features.followup_template){
      return res.status(403).json({ ok:false, error:'FOLLOWUP_TEMPLATE_DISABLED' });
    }
  }

  await setSetting('followup_steps', JSON.stringify(steps), req.user.tenant_id);

  await setSetting('followup_allowed_stages', JSON.stringify(allowed_stages), req.user.tenant_id);

  // если включили дожим — останавливаем рассылки
  if (enabled === '1') {
    await run(
      `UPDATE campaigns SET status='paused', processing=0
      WHERE tenant_id=? AND status='running'`,
      [req.user.tenant_id]
    );
  }

  // --- DEBUG: что реально лежит в БД после сохранения
  const saved = await getSetting('followup_steps', req.user.tenant_id);
  console.log('[FU][POST][SAVED] tid=%s value=%s', req.user.tenant_id, saved);

  res.json({ ok:true });
});
app.post('/api/followup/run', authGuard, async (_req,res)=>{ try{ await processFollowUps(); res.json({ok:true}); }catch(e){ res.status(500).json({ok:false,error:e.message}); }});
app.get('/api/followup/debug', authGuard, async (req,res)=>{
  const now=nowSec(); const out=[];
  const accs=await listAccountsByTenant(req.user.tenant_id);
  for(const a of accs){
    const rows=await all(`SELECT jid, 
      MAX(CASE WHEN type='out' THEN ts END) AS outTs,
      MAX(CASE WHEN type='in'  THEN ts END) AS inTs
      FROM chats WHERE tenant_id=? AND acc_id=? AND ts>?
      GROUP BY jid ORDER BY MAX(ts) DESC LIMIT 100`,[req.user.tenant_id, a.id, now-3*86400]);
    for(const r of rows){
      const p=await getProfile(a.id,r.jid);
      out.push({acc_id:a.id,jid:r.jid,stage:p?.stage||'unknown',outTs:Number(r.outTs||0),inTs:Number(r.inTs||0),now});
    }
  }
  res.json(out);
});

app.get('/api/telegram', authGuard, async (req,res)=>{
  const tkn  = await getSetting('telegram_token', req.user.tenant_id) || '';
  const chat = await getSetting('telegram_chat',  req.user.tenant_id) || '';

  let codes = [];
  try { codes = JSON.parse(await getSetting('telegram_events', req.user.tenant_id)||'[]'); } catch(_){}

  // ⬇️ маппим сохранённые коды -> читабельные метки для UI
  const events = (Array.isArray(codes)?codes:[])
    .map(k => TG_EVENT_MAP[k])
    .filter(Boolean);

  res.json({
    token: tkn ? '***' : '',
    chat,
    events,                // <-- уже метки
    event_labels: TG_EVENT_MAP
  });
});
app.post('/api/telegram', authGuard, async (req,res)=>{
  let { token, chat, events } = req.body||{};
  if (typeof token === 'string') await setSetting('telegram_token', token.trim(), req.user.tenant_id);
  if (typeof chat  === 'string') await setSetting('telegram_chat',  chat.trim(), req.user.tenant_id);
  if (Array.isArray(events)) {
    const norm = events.map(e => TG_EVENT_MAP_REV[e] || e).filter(k => TG_EVENT_MAP[k]);
    await setSetting('telegram_events', JSON.stringify(norm), req.user.tenant_id);
  }
  res.json({ok:true});
});

// -------------------------------------------------
// API: Media Triggers
// -------------------------------------------------
app.get('/api/media_triggers', authGuard, async (req, res) => {
  const list = await loadMediaTriggers(req.user.tenant_id);
  res.json({ ok:true, items: list });
});

app.post('/api/media_triggers', authGuard, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    const norm = incoming.slice(0, 50).map(x => {
      let media_kind = (x.media_kind === 'video' ? 'video' : (x.media_kind === 'image' ? 'image' : ''));
      // авто-детект, если не указали явно
      if (!media_kind && x.media_file) {
        media_kind = inferKindFromPath(x.media_file) || '';
      }
      return {
        label: String(x.label || '').slice(0, 120),
        match_type: x.match_type === 'regex' ? 'regex' : 'contains',
        pattern: String(x.pattern || '').slice(0, 400),
        media_file: String(x.media_file || ''),
        media_kind,
        caption: String(x.caption || ''),
        also_reply_text: String(x.also_reply_text || '')
      };
    });

    await setSetting('media_triggers', JSON.stringify(norm), req.user.tenant_id);
    const saved = await loadMediaTriggers(req.user.tenant_id);
    res.json({ ok: true, items: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------------------------------
// API: Templates
// -------------------------------------------------
app.get('/api/templates', authGuard, async (req,res)=>{ res.json(await listTemplates(req.user.tenant_id)); });
app.post('/api/templates', authGuard, async (req,res)=>{
  const tid = req.user.tenant_id;
  const id = req.body?.id ? Number(req.body.id) : null;
  const title = (req.body?.title||'').trim().slice(0,200);
  const body  = (req.body?.body ||'').toString().slice(0,4000);  
  const media_file = (req.body?.media_file||'').toString();
  const mkRaw = (req.body?.media_kind || '').toString().toLowerCase();
  const media_kind = ['image','video','audio','video_note'].includes(mkRaw) ? mkRaw : '';
  const ts = Date.now();
  if (id){
    const own = await get(`SELECT id FROM msg_templates WHERE tenant_id=? AND id=?`, [tid, id]);
    if(!own) return res.status(404).json({ok:false,error:'not found'});
    await run(`UPDATE msg_templates SET title=?, body=?, media_file=?, media_kind=?, updated_at=? WHERE id=?`,[title,body,media_file,media_kind,ts,id]);
    res.json({ok:true, id});
  } else {
    const ins = await run(`INSERT INTO msg_templates(tenant_id,title,body,media_file,media_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,[tid,title,body,media_file,media_kind,ts,ts]);
    res.json({ok:true, id: ins.lastID});
  }
});
app.delete('/api/templates/:id', authGuard, async (req,res)=>{
  const tid = req.user.tenant_id; const id=Number(req.params.id);
  await run(`DELETE FROM msg_templates WHERE tenant_id=? AND id=?`,[tid,id]);
  res.json({ok:true});
});
app.post('/api/templates/render', authGuard, async (req,res)=>{
  const tid = req.user.tenant_id;
  const id=Number(req.body?.id), acc_id=Number(req.body?.acc_id), jid=String(req.body?.jid||'');
  const tpl = await getTemplate(tid, id); if(!tpl) return res.status(404).json({ok:false,error:'not found'});
  const acc = await get(`SELECT tenant_id FROM accounts WHERE id=?`, [acc_id]);
  if(!acc || acc.tenant_id!==tid) return res.status(403).json({ok:false,error:'forbidden'});
  const profile = await getProfile(acc_id, jid); const accCfg = await getAccLLMConfig(acc_id);
  res.json({ ok:true, text: renderTextTemplate(tpl.body||'', profile, accCfg), media_file: tpl.media_file||'', media_kind: tpl.media_kind||'' });
});

// -------------------------------------------------
// API: Accounts
// -------------------------------------------------

app.get('/api/accounts', authGuard, async (req,res)=>{
  const inc = String(req.query.include_orphans || '').toLowerCase();
  const withOrphans = (inc === '1' || inc === 'true' || inc === 'yes');
  const rows = withOrphans
    ? await listAccountsByTenantWithOrphans(req.user.tenant_id)
    : await listAccountsByTenant(req.user.tenant_id);
  res.json(rows);
});

// CREATE account (WA/TG)
app.post('/api/accounts', authGuard, async (req,res)=>{
  try{
    const tenantId = Number(req.user.tenant_id);

    const kind  = String(req.body?.kind  || '').trim().toLowerCase(); // ✅ обязательно lowerCase
    const label = String(req.body?.label || '').trim();

    const tg_token = String(req.body?.tg_token || '').trim();

    // ✅ wa_engine теперь всегда 'baileys' (только Baileys)
    const wa_engine = 'baileys';

    if (!label) return res.status(400).json({ ok:false, error:'label_required' });
    if (!['wa','tg'].includes(kind)) return res.status(400).json({ ok:false, error:'kind_invalid' });
    if (kind === 'tg' && !tg_token) return res.status(400).json({ ok:false, error:'tg_token_required' });

    const now = Date.now();

    const ins = await run(
      `INSERT INTO accounts(tenant_id, kind, label, status, folder, tg_token, wa_engine, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [tenantId, kind, label, 'offline', null, (kind==='tg'?tg_token:null), (kind==='wa'?wa_engine:null), now, now]
    );

    const id = ins?.lastID;

    // ✅ folder по движку
    if (kind === 'wa' && id) {
      const folder = path.join('auth', `acc-${id}`);
      await run(
        `UPDATE accounts SET folder=?, wa_engine=?, updated_at=? WHERE id=?`,
        [folder, wa_engine, Date.now(), id]
      );
    }

    await broadcastAccList(tenantId);

    // ✅ ВАЖНО: ответ клиенту (если ты случайно удалил res.json ниже)
    return res.json({ ok:true, id });

  }catch(e){
    console.error('[POST /api/accounts] error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

async function ensureOwnAccount(req, accId){
  const row = await get(`SELECT tenant_id FROM accounts WHERE id=?`, [accId]);
  if(!row || row.tenant_id!==req.user.tenant_id) return false;
  return true;
}

async function ensureOwnAccountOrHistory(req, accId){
  if (await ensureOwnAccount(req, accId)) return true;

  // аккаунта нет в accounts, но разрешаем READ, если у тенанта есть данные по этому acc_id
  const tid = req.user.tenant_id;
  const has =
    (await get(`SELECT 1 ok FROM profiles WHERE tenant_id=? AND acc_id=? LIMIT 1`, [tid, accId])) ||
    (await get(`SELECT 1 ok FROM chats    WHERE tenant_id=? AND acc_id=? LIMIT 1`, [tid, accId]));

  return !!has;
}

app.post('/api/accounts/:id/start', authGuard, async (req,res)=>{
  const id=Number(req.params.id);
  if(!await ensureOwnAccount(req, id)) return res.status(403).json({ok:false,error:'forbidden'});
  await startAccount(id); await broadcastAccList(req.user.tenant_id); res.json({ok:true});
});
app.post('/api/accounts/:id/stop',  authGuard, async (req,res)=>{
  const id=Number(req.params.id);
  if(!await ensureOwnAccount(req, id)) return res.status(403).json({ok:false,error:'forbidden'});
  await stopAccount(id);  await broadcastAccList(req.user.tenant_id); res.json({ok:true});
});
app.post('/api/accounts/:id/logout',authGuard, async (req,res)=>{
  const id=Number(req.params.id);
  if(!await ensureOwnAccount(req, id)) return res.status(403).json({ok:false,error:'forbidden'});
  await logoutAccount(id);await broadcastAccList(req.user.tenant_id); res.json({ok:true});
});
app.delete('/api/accounts/:id',     authGuard, async (req,res)=>{
  const id=Number(req.params.id);
  if(!await ensureOwnAccount(req, id)) return res.status(403).json({ok:false,error:'forbidden'});
  await stopAccount(id).catch(()=>{});
  const acc = await get(`SELECT folder, kind, wa_engine FROM accounts WHERE id=?`, [id]);
  const kind = String(acc?.kind || 'wa').toLowerCase();
  const waEngine = String(acc?.wa_engine || 'baileys').toLowerCase();
  
  // ✅ Удаляем Baileys сессию
  if ((kind === 'wa' || kind === 'whatsapp') && acc?.folder) {
    await rmrf(acc.folder);
  }
  
  
  await run(`DELETE FROM accounts WHERE id=?`,[id]);
  await broadcastAccList(req.user.tenant_id);
  res.json({ok:true});
});
app.post('/api/accounts/:id/config', authGuard, async (req,res)=>{
  const id=Number(req.params.id);
  if(!await ensureOwnAccount(req, id)) return res.status(403).json({ok:false,error:'forbidden'});

  const model=(req.body?.model||'').trim();
  const temperature=Number(req.body?.temperature);
  let   max_tokens = parseInt(req.body?.max_tokens,10);
  if (isFinite(max_tokens)) max_tokens = Math.max(50, Math.min(max_tokens, 4000)); else max_tokens = null;

  const forced_lang=(req.body?.forced_lang||'').trim();
  const ai_enabled = (req.body?.ai_enabled===undefined ? null : (req.body.ai_enabled ? 1 : 0)); // ← добавили

  await run(
    `UPDATE accounts
       SET model=COALESCE(?,model),
           temperature=COALESCE(?,temperature),
           max_tokens=COALESCE(?,max_tokens),
           forced_lang=?,
           ai_enabled=COALESCE(?,ai_enabled)               -- ← добавили
     WHERE id=?`,
    [model||null, isFinite(temperature)?temperature:null, max_tokens, forced_lang||null, ai_enabled, id]
  );

  await broadcastAccList(req.user.tenant_id);
  res.json({ok:true});
});

app.post('/api/wa/ping', authGuard, async (req, res) => {
  try{
    const acc_id = Number(req.body?.acc_id);
    let jid    = String(req.body?.jid||'').trim();
    if (!acc_id || !jid) return res.status(400).json({ ok:false, error:'acc_id & jid required' });
    if (!await ensureOwnAccount(req, acc_id)) return res.status(403).json({ ok:false, error:'forbidden' });

    if (!await isAccReady(acc_id)) {
      return res.status(409).json({ ok:false, error:'WA_NOT_READY: connection is not open' });
    }
    const sock = sockets.get(acc_id).sock;

    jid = normalizeDirectJid(jid);
    if (!jid) return res.status(400).json({ ok:false, error:'bad jid' });

    if (
      jid === 'status@broadcast' ||
      jid.endsWith('@g.us') ||
      jid.endsWith('@broadcast') ||
      jid.endsWith('@newsletter')
    ) {
      return res.status(400).json({ ok:false, error:'not a direct jid' });
    }

    // «пинг» коротким сообщением без текста — самый надёжный триггер пересборки
    await sock.sendMessage(jid, { text: '.' });
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/wa/diag', authGuard, async (req, res) => {
  try{
    const rows = await all(`SELECT id, label, status, me_jid, updated_at FROM accounts WHERE tenant_id=? ORDER BY id`, [req.user.tenant_id]);
    const withSock = rows.map(r => ({ ...r, has_sock: !!sockets.get(r.id)?.sock }));
    res.json({ ok:true, accounts: withSock });
  }catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// -------------------------------------------------
// API: Leads & Stats
// -------------------------------------------------
async function countLeadsBetween(startTs,endTs,tenantId,accId){
  const params=[tenantId,startTs,endTs];
  let sql=`SELECT COUNT(DISTINCT jid) c FROM chats WHERE tenant_id=? AND type='in' AND ts BETWEEN ? AND ?`;
  if(accId){ sql+=` AND acc_id=?`; params.push(Number(accId)); }
  return Number((await get(sql,params))?.c||0);
}
app.get('/api/leads/summary', authGuard, async (req,res)=>{
  const accId=req.query.acc_id?Number(req.query.acc_id):null;
  if(accId && !await ensureOwnAccount(req, accId)) return res.status(403).json({ok:false,error:'forbidden'});
  const now=nowSec();
  res.json({
    last_hour: await countLeadsBetween(now-3600,now,req.user.tenant_id,accId),
    today:     await countLeadsBetween(startOfUTCDay(now),now,req.user.tenant_id,accId),
    last_7d:   await countLeadsBetween(now-7*86400,now,req.user.tenant_id,accId),
    last_30d:  await countLeadsBetween(now-30*86400,now,req.user.tenant_id,accId)
  });
});
app.get('/api/leads/by_month', authGuard, async (req,res)=>{
  const accId=req.query.acc_id?Number(req.query.acc_id):null;
  if(accId && !await ensureOwnAccount(req, accId)) return res.status(403).json({ok:false,error:'forbidden'});
  const ym=String(req.query.ym||'').trim(); const m=/^(\d{4})-(\d{2})$/.exec(ym);
  if(!m) return res.status(400).json({ok:false,error:'ym must be YYYY-MM'});
  const year=Number(m[1]), month=Number(m[2]);
  const start=Math.floor(Date.UTC(year,month-1,1,0,0,0)/1000);
  const end  =Math.floor(Date.UTC(year,month,  1,0,0,0)/1000);
  res.json({ ym, count: await countLeadsBetween(start,end,req.user.tenant_id,accId), start, end });
});

app.get('/api/reports/overall', authGuard, async (req, res) => {
  try {
    const tenantId = Number(req.user.tenant_id);

    const t = await get(`SELECT created_at FROM tenants WHERE id=?`, [tenantId]);
    const raw = Number(t?.created_at || 0);
    // created_at в этом проекте встречается и в секундах, и в миллисекундах — нормализуем
    const sinceMs = raw ? (raw > 1e12 ? raw : raw * 1000) : Date.now();
    const sinceSec = Math.floor(sinceMs / 1000);

    // список месяцев от регистрации до текущего (UTC)
    const start = new Date(sinceMs);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth(); // 0..11
    const now = new Date();
    const endY = now.getUTCFullYear();
    const endM = now.getUTCMonth();

    const ymList = [];
    while (y < endY || (y === endY && m <= endM)) {
      ymList.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m++;
      if (m > 11) { m = 0; y++; }
    }

    // лиды по месяцам (уникальные jid)
    const leadRows = await all(`
      SELECT strftime('%Y-%m', datetime(ts,'unixepoch')) AS ym,
             COUNT(DISTINCT jid) AS leads
      FROM chats
      WHERE tenant_id=? AND type='in'
      GROUP BY ym
    `, [tenantId]);

    // лидов всего (уникальных за весь период)
    const leadTotalRow = await get(
      `SELECT COUNT(DISTINCT jid) AS leads_total
       FROM chats
       WHERE tenant_id=? AND type='in'`,
      [tenantId]
    );

    const leadsByYm = {};
    for (const r of (leadRows || [])) {
      if (!r?.ym) continue;
      leadsByYm[r.ym] = Number(r.leads || 0);
    }

    // SatuCoin по месяцам (пополнения и списания)
    // created_at в satu_transactions хранится в миллисекундах
    const txRows = await all(`
      SELECT strftime('%Y-%m', datetime(created_at/1000,'unixepoch')) AS ym,
             SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS tokens_added,
             SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) AS tokens_spent
      FROM satu_transactions
      WHERE tenant_id=?
      GROUP BY ym
    `, [tenantId]);

    const txByYm = {};
    for (const r of (txRows || [])) {
      if (!r?.ym) continue;
      txByYm[r.ym] = {
        added: Number(r.tokens_added || 0),
        spent: Number(r.tokens_spent || 0)
      };
    }

    const txTotals = await get(
      `SELECT
         SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS tokens_added,
         SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END) AS tokens_spent
       FROM satu_transactions
       WHERE tenant_id=?`,
      [tenantId]
    );

    const months = ymList.map(ym => {
      const leads = leadsByYm[ym] || 0;
      const tokens_added = txByYm[ym]?.added || 0;
      const tokens_spent = txByYm[ym]?.spent || 0;
      return {
        ym,
        leads,
        tokens_added,
        tokens_spent,
        tokens_net: (tokens_added - tokens_spent),
        sum_kzt: tokens_added // legacy: если у вас 1 SatuCoin = 1 ₸
      };
    });

    const totals = {
      leads_total: Number(leadTotalRow?.leads_total || 0),
      tokens_added: Number(txTotals?.tokens_added || 0),
      tokens_spent: Number(txTotals?.tokens_spent || 0),
      tokens_net: Number(txTotals?.tokens_added || 0) - Number(txTotals?.tokens_spent || 0)
    };

    res.json({ ok: true, since: sinceMs, since_sec: sinceSec, totals, months });
  } catch (e) {
    console.error('[api/reports/overall] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stat/daily', authGuard, async (req,res)=>{
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)));
  const since = nowSec() - days * 86400;
  const rows = await all(`
    SELECT date,
           SUM(CASE WHEN type='in'  THEN 1 ELSE 0 END) AS in_count,
           SUM(CASE WHEN type='out' THEN 1 ELSE 0 END) AS out_count
    FROM chats
    WHERE tenant_id=? AND ts >= ?
    GROUP BY date
    ORDER BY date ASC
  `, [req.user.tenant_id, since]);
  res.json({ days, rows });
});

// -------------------------------------------------
// API: AI Ignore list (per-account)
// -------------------------------------------------
app.get('/api/ai_ignore/list', authGuard, async (req,res)=>{
  try{
    const acc_id = Number(req.query?.acc_id);
    if (!acc_id) return res.status(400).json({ok:false,error:'acc_id required'});
    if (!await ensureOwnAccount(req, acc_id)) return res.status(403).json({ok:false,error:'forbidden'});
    const items = await listPermanentIgnores(acc_id);
    res.json({ ok:true, acc_id, count: items.length, items });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/ai_ignore/add', authGuard, async (req,res)=>{
  try{
    const acc_id = Number(req.body?.acc_id);
    const phoneOrJid = String(req.body?.phone||req.body?.jid||'');
    if (!acc_id || !phoneOrJid) return res.status(400).json({ok:false,error:'acc_id and phone/jid required'});
    if (!await ensureOwnAccount(req, acc_id)) return res.status(403).json({ok:false,error:'forbidden'});
    const jid = await addPermanentIgnore(acc_id, phoneOrJid);
    res.json({ ok:true, acc_id, jid, phone: jid.replace(/@.*/,'') });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/ai_ignore/remove', authGuard, async (req,res)=>{
  try{
    const acc_id = Number(req.body?.acc_id);
    const phoneOrJid = String(req.body?.phone||req.body?.jid||'');
    if (!acc_id || !phoneOrJid) return res.status(400).json({ok:false,error:'acc_id and phone/jid required'});
    if (!await ensureOwnAccount(req, acc_id)) return res.status(403).json({ok:false,error:'forbidden'});
    const jid = await removePermanentIgnore(acc_id, phoneOrJid);
    res.json({ ok:true, acc_id, jid, phone: jid.replace(/@.*/,'') });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ==== COMPAT: /api/ai/blocklist → маппим на /api/ai_ignore ====

async function resolveAccId(req) {
  const inReq = Number(req.query?.acc_id || req.body?.acc_id);
  if (inReq) return inReq;
  // если acc_id не передали — берём первый аккаунт тенанта
  const row = await get(`SELECT id FROM accounts WHERE tenant_id=? ORDER BY id LIMIT 1`, [req.user.tenant_id]);
  if (!row) throw new Error('no accounts for tenant');
  return Number(row.id);
}

// GET /api/ai/blocklist  → [{id, phone, note}]
app.get('/api/ai/blocklist', authGuard, requireFeature(FEATURES.SET_STOPLIST), async (req,res)=>{
  try {
    const accId = await resolveAccId(req);
    const items = await listPermanentIgnores(accId); // { jid, phone }
    // фронту нужен id — используем сам номер как id (URL-энкодим)
    const rows = items.map((it) => ({
      id: encodeURIComponent(it.phone),    // для DELETE
      phone: (it.phone.startsWith('+') ? it.phone : '+' + it.phone), // красиво отобразить
      note: ''
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ai/blocklist  → body: {phones:[...]} | {phone:"..."}
app.post('/api/ai/blocklist', authGuard, requireFeature(FEATURES.SET_STOPLIST), async (req,res)=>{
  try {
    const accId = await resolveAccId(req);
    const list = Array.isArray(req.body?.phones) && req.body.phones.length
      ? req.body.phones
      : (req.body?.phone ? [req.body.phone] : []);
    if (!list.length) return res.status(400).json({ ok: false, error: 'phone(s) required' });

    for (const raw of list) {
      const digits = String(raw).replace(/[^\d]/g, ''); // принимаем E.164 (+ убираем)
      if (digits.length < 8 || digits.length > 15) continue;
      await addPermanentIgnore(accId, digits);          // addPermanentIgnore сам сделает JID
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/ai/blocklist/:id  → id = encodeURIComponent(phone)
app.delete('/api/ai/blocklist/:id', authGuard, async (req, res) => {
  try {
    const accId = await resolveAccId(req);
    const phone = decodeURIComponent(req.params.id || '');
    if (!phone) return res.status(400).json({ ok: false, error: 'bad id' });
    const digits = String(phone).replace(/[^\d]/g, '');
    if (!digits) return res.status(400).json({ ok: false, error: 'bad phone' });
    await removePermanentIgnore(accId, digits);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------------------------------
// API: Profiles / Manual send / Escalations
// -------------------------------------------------
app.get('/api/profiles', authGuard, async (req,res)=>{
  const accId = req.query.acc_id ? Number(req.query.acc_id) : null;
  const q = String(req.query.q||'').trim().toLowerCase();
  const stage = String(req.query.stage||'').trim();

  let limit = parseInt(String(req.query.limit || '5000'), 10);
  if (!Number.isFinite(limit)) limit = 5000;
  limit = Math.max(1, Math.min(limit, 100000));

  const tenantId = req.user.tenant_id;

  // ✅ LID phone join: берём номер из lid_mapping по текущему acc_id (или глобальный acc_id=0)
  let sql = '';
  const params = [];

  if (accId) {
    if(!await ensureOwnAccountOrHistory(req, accId)) return res.status(403).json({ok:false,error:'forbidden'});

    sql = `SELECT p.*, lm.phone_number AS lid_phone
           FROM profiles p
           LEFT JOIN lid_mapping lm
             ON lm.lid=p.jid AND lm.is_verified=1 AND (lm.acc_id=? OR lm.acc_id=0)
           WHERE p.tenant_id=? AND (p.acc_id=? OR p.acc_id=0)`;
    params.push(accId, tenantId, accId);

    // Не показываем "самого себя" (номер, которым привязан аккаунт)
    try {
      const acc = await get(
        `SELECT kind, me_jid FROM accounts WHERE id=? AND tenant_id=?`,
        [accId, tenantId]
      );

      const kind = String(acc?.kind || '');
      const meRaw = String(acc?.me_jid || '').trim();
      const meNorm = meRaw ? normalizeMeJid(meRaw) : '';

      if (kind === 'wa') {
        if (meNorm) { sql += ` AND p.jid <> ?`; params.push(meNorm); }
        if (meRaw && meRaw !== meNorm) { sql += ` AND p.jid <> ?`; params.push(meRaw); }
      }
    } catch(_) {}

  } else {
    sql = `SELECT p.*, lm.phone_number AS lid_phone
           FROM profiles p
           LEFT JOIN lid_mapping lm
             ON lm.acc_id=p.acc_id AND lm.lid=p.jid AND lm.is_verified=1
           WHERE p.tenant_id=?`;
    params.push(tenantId);
  }

  if (stage){
    sql += ` AND p.stage=?`;
    params.push(stage);
  }

  if (q){
    sql += ` AND (
      LOWER(p.jid) LIKE ?
      OR LOWER(p.name) LIKE ?
      OR LOWER(p.city) LIKE ?
      OR LOWER(p.budget) LIKE ?
      OR LOWER(p.interest) LIKE ?
      OR LOWER(p.stage) LIKE ?
      OR LOWER(COALESCE(lm.phone_number,'')) LIKE ?
    )`;
    const pat = `%${q}%`;
    params.push(pat, pat, pat, pat, pat, pat, pat);
  }

  const order = String(req.query.order||'').trim().toLowerCase();
  if (order === 'recent') {
    sql += ` ORDER BY COALESCE(p.slots_updated_at,0) DESC, p.acc_id, p.jid LIMIT ?`;
  } else {
    sql += ` ORDER BY p.acc_id, p.jid LIMIT ?`;
  }

  params.push(limit);

  const rows = await all(sql, params);

  // ✅ Дедуп контактов по нормализованному jid (убирает @lid-дубли в UI)
  let out = rows;

  if (accId) {
    try {
      const acc = await get(`SELECT kind FROM accounts WHERE id=? AND tenant_id=?`, [accId, tenantId]);
      const kind = String(acc?.kind || 'wa').toLowerCase();

      if (kind === 'wa' || kind === '') {
        const map = new Map();
        for (const r of rows) {
          const key = normalizeDirectJid(r.jid);
          const prev = map.get(key);

          const rTs = Number(r.slots_updated_at || 0);
          const pTs = Number(prev?.slots_updated_at || 0);

          if (!prev || rTs >= pTs) map.set(key, r);
        }
        out = Array.from(map.values());
      }
    } catch(_) {}
  }

  // ✅ добавляем вычисляемое поле phone для фронта
  const enriched = (out || []).map(r => {
    const jid = String(r.jid || '').trim();
    let phone = '';

    if (jid.startsWith('tg:')) {
      phone = jid.slice(3);
    } else if (jid.startsWith('ig:')) {
      phone = ''; // у IG нет телефона
    } else {
      phone = jidToPhone(jid) || '';
      if (!phone && jid.endsWith('@lid')) {
        phone = String(r.lid_phone || '').replace(/\D+/g,'');
      }
    }

    const o = { ...r, phone };
    delete o.lid_phone;
    return o;
  });

  res.json(enriched);
});

// === Profile avatar (WA) ===
app.get('/api/profile/avatar', authGuard, async (req, res) => {
  try {
    const accId = Number(req.query.acc_id || 0);
    const jid = String(req.query.jid || '').trim();
    if (!accId || !jid) return res.status(400).json({ ok: false, error: 'acc_id & jid required' });

    // можно как ensureOwnAccount, но тут безопаснее allow history (чтобы работало для просмотренных контактов)
    if (!await ensureOwnAccountOrHistory(req, accId)) {
      return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const acc = await get(`SELECT kind FROM accounts WHERE id=? AND tenant_id=?`, [accId, req.user.tenant_id]);
    const kind = String(acc?.kind || 'wa').toLowerCase();
    if (kind !== 'wa') return res.json({ ok:true, url:'' });

    const rec = sockets.get(accId);
    const sock = rec?.sock;
    if (!sock || typeof sock.profilePictureUrl !== 'function') {
      return res.json({ ok:true, url:'' });
    }

    let targetJid = jid;
    try {
      if (String(jid||'').endsWith('@lid')) {
        const m = await get(
          `SELECT phone_jid FROM lid_mapping WHERE acc_id=? AND lid=? AND is_verified=1 ORDER BY updated_at DESC LIMIT 1`,
          [accId, jid]
        );
        if (m?.phone_jid) targetJid = m.phone_jid;
      }
    } catch(_) {}

    let url = '';
    try {
      url = await sock.profilePictureUrl(targetJid, 'image');
    } catch (_) {
      url = '';
    }

    return res.json({ ok:true, url: url || '' });
  } catch (e) {
    return res.json({ ok:true, url:'' });
  }
});

app.post('/api/profiles/update', authGuard, async (req,res)=>{
  const { acc_id, jid, name, city, budget, interest, notes, lang, last_intent, summary, stage } = req.body||{};
  if (!acc_id || !jid) return res.status(400).json({ok:false, error:'acc_id & jid required'});

  // --- FIX: всегда сохраняем только нормальный jid (иначе плодятся дубли) ---
  const accIdNum = Number(acc_id);
  const accKind = await getAccKind(accIdNum); // 'wa' | 'tg'
  let jidNorm = String(jid||'').trim();

  if (accKind === 'tg') jidNorm = normalizeTgJid(jidNorm);
  else jidNorm = normalizeDirectJid(jidNorm);

  if (!jidNorm) return res.status(400).json({ ok:false, error:'bad jid' });

  if(!await ensureOwnAccount(req, Number(acc_id))) return res.status(403).json({ok:false,error:'forbidden'});
  await saveProfile(accIdNum, jidNorm, { name, city, budget, interest, notes, lang, last_intent, summary, stage });
  res.json({ok:true});
});

app.post('/api/profiles/delete', authGuard, async (req,res)=>{
  // Удаление лида + всей истории (WA/TG/IG).
  // Важно: физическое удаление сообщений разрешено только через delete_guard (см. триггеры в initDB()).
  let txStarted = false;
  try{
    const { acc_id, jid } = req.body || {};
    if (!acc_id || !jid) return res.status(400).json({ ok:false, error:'acc_id & jid required' });

    const accIdNum = Number(acc_id);
    if (!accIdNum) return res.status(400).json({ ok:false, error:'bad acc_id' });

    if (!await ensureOwnAccount(req, accIdNum)) return res.status(403).json({ ok:false, error:'forbidden' });

    const tenantId = req.user.tenant_id;

    const kind = String(await getAccKind(accIdNum) || 'wa').toLowerCase();

    let jidCanon = String(jid || '').trim();
    if (kind === 'tg') {
      jidCanon = normalizeTgJid(jidCanon);
    } else if (kind === 'ig') {
      jidCanon = jidCanon.startsWith('ig:') ? jidCanon : ('ig:' + jidCanon);
    } else {
      jidCanon = normalizeDirectJid(jidCanon);
    }

    if (!jidCanon) return res.status(400).json({ ok:false, error:'bad jid' });

    // На всякий случай: не даём удалить "самого себя" у WA-аккаунта
    try{
      const acc = await get(`SELECT kind, me_jid FROM accounts WHERE id=? AND tenant_id=?`, [accIdNum, tenantId]);
      const k = String(acc?.kind || '').toLowerCase();
      const meRaw = String(acc?.me_jid || '').trim();
      const meNorm = meRaw ? normalizeMeJid(meRaw) : '';
      if (k === 'wa' && meNorm && (jidCanon === meNorm)) {
        return res.status(400).json({ ok:false, error:'cannot delete own number' });
      }
    }catch(_){}

    // Варианты jid для WA (@s.whatsapp.net <-> @lid)
    const jids = [];
    const push = (x)=>{ if (x && !jids.includes(x)) jids.push(x); };

    push(jidCanon);
    if (jidCanon.endsWith('@s.whatsapp.net')) push(jidCanon.replace(/@s\.whatsapp\.net$/i, '@lid'));
    if (jidCanon.endsWith('@lid')) push(jidCanon.replace(/@lid$/i, '@s.whatsapp.net'));

    // открываем короткое окно, в котором триггер разрешит DELETE
    const until = nowSec() + 60;

    await run('BEGIN');
    txStarted = true;

    for (const j of jids){
      await run(
        `INSERT OR REPLACE INTO delete_guard(tenant_id, acc_id, jid, until_ts) VALUES(?,?,?,?)`,
        [tenantId, accIdNum, j, until]
      );
    }

    const qIn = '(' + jids.map(()=>'?').join(',') + ')';
    const pAcc = [tenantId, accIdNum, ...jids];
    const pNoAcc = [tenantId, ...jids];

    // 1) Профиль лида
    await run(`DELETE FROM profiles WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

    // 2) История чатов (общая таблица)
    await run(`DELETE FROM chats WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

    // 3) Блокировки / дожимы / состояния
    await run(`DELETE FROM blocks WHERE tenant_id=? AND jid IN ${qIn}`, pNoAcc);
    await run(`DELETE FROM followups WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
    await run(`DELETE FROM firstmsg_state WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
    await run(`DELETE FROM firstmsg_jobs WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

    // 4) Эскалации / чеки
    await run(`DELETE FROM escalations WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
    await run(`DELETE FROM receipts WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

    // 5) Instagram raw-таблицы (если это IG jid)
    if (jids.some(j => String(j).startsWith('ig:'))){
      const threadIds = jids
        .filter(j => String(j).startsWith('ig:'))
        .map(j => String(j).slice(3))
        .filter(Boolean);

      if (threadIds.length){
        const qT = '(' + threadIds.map(()=>'?').join(',') + ')';
        await run(`DELETE FROM ig_chat_state WHERE tenant_id=? AND thread_id IN ${qT}`, [tenantId, ...threadIds]);
        await run(`DELETE FROM ig_chats WHERE tenant_id=? AND thread_id IN ${qT}`, [tenantId, ...threadIds]);
      }
    }

    // cleanup guard
    await run(`DELETE FROM delete_guard WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

    await run('COMMIT');
    txStarted = false;

    return res.json({ ok:true });
  }catch(e){
    if (txStarted) { try{ await run('ROLLBACK'); }catch(_){} }
    return res.status(500).json({ ok:false, error: e.message });
  }
});

async function ensureOggOpusForWaba(absPath) {
  try {
    if (!absPath) return absPath;
    const ext = path.extname(absPath).toLowerCase();

    // уже ogg - ок
    if (ext === '.ogg') return absPath;

    // конвертим (webm/m4a/mp4/.. -> ogg/opus)
    const outPath = absPath.replace(/\.[^.]+$/i, '') + '.ogg';

    await new Promise((resolve, reject) => {
      execFile(
        process.env.FFMPEG_BIN || '/usr/bin/ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel', 'error',
          '-i', absPath,
          '-vn',
          '-ac', '1',
          '-ar', '48000',
          '-c:a', 'libopus',
          '-b:a', '24k',
          outPath
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });

    return outPath;
  } catch (e) {
    console.warn('[FFMPEG][ogg] convert fail, send original:', e?.message || e);
    return absPath; // не ломаем отправку
  }
}

// ===================================================================
// WABA: Проверка и отправка через Meta Cloud API
// ===================================================================
async function sendViaWABA(acc_id, jid, text, media_file, media_kind) {
  const account = await get(
    `SELECT waba_provider, waba_phone_number_id, waba_access_token, gupshup_app_id, gupshup_app_token
     FROM accounts WHERE id = ? AND waba_enabled = 1`,
    [acc_id]
  );

  const prov = String(account?.waba_provider || 'meta');

  if (prov === 'gupshup') {
    if (!account.gupshup_app_id || !account.gupshup_app_token) {
      throw new Error('Gupshup WABA not configured');
    }

    const to = String(jid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!to) throw new Error('Bad jid');

    const url = `${GUP_BASE}/partner/app/${account.gupshup_app_id}/v3/message`;

    const form = new URLSearchParams();
    form.set('messaging_product', 'whatsapp');
    form.set('recipient_type', 'individual');
    form.set('to', to);

    // минимум: text + link media
    if (media_file && media_kind && /^https?:\/\//i.test(media_file)) {
      form.set('type', media_kind);
      if (media_kind === 'image') form.set('image', JSON.stringify({ link: media_file, caption: text || '' }));
      else if (media_kind === 'video') form.set('video', JSON.stringify({ link: media_file, caption: text || '' }));
      else if (media_kind === 'document') form.set('document', JSON.stringify({ link: media_file, caption: text || '' }));
      else if (media_kind === 'audio') form.set('audio', JSON.stringify({ link: media_file }));
      else {
        form.set('type', 'text');
        form.set('text', JSON.stringify({ body: text || '' }));
      }
    } else {
      form.set('type', 'text');
      form.set('text', JSON.stringify({ body: text || '' }));
    }

    const resp = await axios.post(url, form.toString(), {
      headers: {
        Authorization: String(account.gupshup_app_token),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 20000
    });

    return resp.data;
  }

  if (!account || !account.waba_phone_number_id || !account.waba_access_token) {
    throw new Error('WABA not configured for this account');
  }

  const wabaClient = new WABAClient(
    account.waba_phone_number_id,
    account.waba_access_token
  );

  const phone = String(jid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');

  let result = null;

  if (media_file && media_kind) {
    // 1) Если уже ссылка — используем link-режим (как раньше)
    if (/^https?:\/\//i.test(media_file)) {
      if (media_kind === 'image') result = await wabaClient.sendImage(phone, media_file, text || '');
      else if (media_kind === 'video') result = await wabaClient.sendVideo(phone, media_file, text || '');
      else if (media_kind === 'audio') {
        result = await wabaClient.sendAudio(phone, media_file);
        if (text) result = await wabaClient.sendText(phone, text);
      } else if (media_kind === 'document') {
        result = await wabaClient.sendDocument(phone, media_file, 'file', text || '');
      }
    } else {
      // 2) Иначе это локальный файл -> upload -> send by media_id (самый надежный режим для WABA)
      const rel = String(media_file).replace(/^\/+/, ''); // на случай если пришло "/uploads/.."
      const abs = path.resolve(__dirname, rel);
      if (!fs.existsSync(abs)) throw new Error('Media file not found');

      let absToSend = abs;

      // ✅ если audio/voice — конвертим в ogg/opus, чтобы WABA точно принял
      if (media_kind === 'audio') {
        absToSend = await ensureOggOpusForWaba(absToSend);
      }

      const ext = path.extname(absToSend).toLowerCase();
      const mime =
        media_kind === 'image' ? (ext === '.png' ? 'image/png' : 'image/jpeg') :
        media_kind === 'video' ? 'video/mp4' :
        media_kind === 'audio' ? (ext === '.mp3' ? 'audio/mpeg' : 'audio/ogg; codecs=opus') :
        media_kind === 'document' ? 'application/pdf' :
        'application/octet-stream';

      const mediaId = await wabaClient.uploadMedia(absToSend, mime);

      // В твоём waba.js sendMediaById(to, mediaId, mediaType, caption='')
      result = await wabaClient.sendMediaById(
        phone,
        mediaId,
        (media_kind === 'video_note') ? 'video' : media_kind,
        text || ''
      );

      // у аудио нет caption — если текст нужен, отправим вторым сообщением
      if (media_kind === 'audio' && text) {
        await wabaClient.sendText(phone, text);
      }
    }
  } else if (text) {
    result = await wabaClient.sendText(phone, text);
  } else {
    throw new Error('Nothing to send');
  }

  return result; // <-- ВАЖНО: возвращаем ответ Graph API
}

async function sendReactionViaWABA(acc_id, jid, msg_ref, emoji){
  const account = await get(
    `SELECT waba_phone_number_id, waba_access_token FROM accounts WHERE id = ? AND waba_enabled = 1`,
    [acc_id]
  );
  if (!account || !account.waba_phone_number_id || !account.waba_access_token) {
    throw new Error('WABA not configured for this account');
  }
  const wabaClient = new WABAClient(account.waba_phone_number_id, account.waba_access_token);
  const phone = String(jid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
  return wabaClient.sendReaction(phone, String(msg_ref), String(emoji ?? ''));
}

// Проверка: WABA или Baileys?
async function isWABAAccount(acc_id) {
  const account = await get(
    `SELECT waba_enabled FROM accounts WHERE id = ?`,
    [acc_id]
  );
  return account?.waba_enabled === 1;
}

app.post('/api/send', authGuard, async (req,res)=>{
  console.log('========================================');
  console.log('[/api/send] START', {
    acc_id: req.body?.acc_id,
    jid: req.body?.jid,
    text: req.body?.text,
    media_file: req.body?.media_file,
    media_kind: req.body?.media_kind
  });
  console.log('========================================');
  
  try{
    let acc_id = Number(req.body?.acc_id);
    console.log('[1] acc_id =', acc_id);
    
    let jid = String(req.body?.jid||'').trim();
    console.log('[2] jid =', jid);
    
    const text = String(req.body?.text||'');
    console.log('[3] text =', text);
    const media_file = String(req.body?.media_file||'');
    const req_kind   = String(req.body?.media_kind||'').toLowerCase(); // raw

    if (!acc_id || !jid) return res.status(400).json({ok:false,error:'acc_id & jid required'});
    if (!await ensureOwnAccountOrHistory(req, acc_id)) return res.status(403).json({ok:false,error:'forbidden'});

    const tenantId = await getAccTenant(acc_id);
    const accKind = await getAccKind(acc_id);

    // normalize jid by channel
    if (accKind === 'tg') {
      const j = normalizeTgJid(jid);
      if (!j) return res.status(400).json({ ok:false, error:'bad tg jid' });
      jid = j;
    } else if (accKind !== 'ig') {
      const j = normalizeDirectJid(jid);
      if (!j) return res.status(400).json({ ok:false, error:'bad jid' });
      jid = j;

      if (
        jid === 'status@broadcast' ||
        jid.endsWith('@g.us') ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter')
      ) {
        return res.status(400).json({ ok:false, error:'not a direct jid' });
      }
    }

    // INSTAGRAM (virtual account: acc_id = -tenant_id)
    if (accKind === 'ig') {
      const threadId = jid.startsWith('ig:') ? jid.slice(3) : jid;
      if (!threadId) return res.status(400).json({ ok:false, error:'bad ig jid' });

      // берём токен подключения IG
      const conn = await get(
        `SELECT access_token FROM ig_connections WHERE tenant_id=? ORDER BY connected_at DESC LIMIT 1`,
        [tenantId]
      );
      const token = String(conn?.access_token || '').trim();
      if (!token) return res.status(409).json({ ok:false, error:'IG_NOT_CONNECTED' });

      // рендер текста (если у тебя в тексте есть {{name}} и т.п.)
      let profile = null;
      try{ profile = await getProfile(acc_id, `ig:${threadId}`); }catch(_){}
      let accCfg = null;
      try{ accCfg = await getAccLLMConfig(acc_id); }catch(_){}
      const finalText = renderTextTemplate(text, profile || {}, accCfg || {}) || undefined;

      if (!finalText) return res.status(400).json({ ok:false, error:'nothing to send' });

      await igSendLongText(token, threadId, finalText);

      const ts = Date.now();
      await run(
        `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
        VALUES(?,?,?,?,?,?,?)`,
        [tenantId, threadId, '', ts, 'out', finalText, JSON.stringify({manual:true}).slice(0, 200000)]
      );

      // realtime bump
      try{
        const date = new Date(ts).toISOString().slice(0,10);
        io.to(`tenant_${tenantId}`).emit('newchat',{
          acc_id: acc_id,              // тут acc_id уже будет отрицательный (как пришёл с фронта)
          jid: `ig:${threadId}`,
          phone: String(threadId),
          text: finalText,
          date
        });
      }catch(_){}

      return res.json({ ok:true });
    }

    // TELEGRAM
    if (accKind === 'tg') {
      const toJid = normalizeTgJid(jid);
      if (!toJid) return res.status(400).json({ ok:false, error:'bad tg jid' });
      jid = toJid;

      if (!await isAccReady(acc_id)) {
        return res.status(409).json({ ok:false, error:'TG_NOT_READY' });
      }

      const recTg = tgBots.get(acc_id);
      const token = recTg?.token || (await get(`SELECT tg_token FROM accounts WHERE id=?`, [acc_id]))?.tg_token;
      if (!token) return res.status(409).json({ ok:false, error:'TG_NO_TOKEN' });

      const chatId = tgJidToChatId(jid);
      if (!chatId) return res.status(400).json({ ok:false, error:'bad chat_id' });

      const profile = await getProfile(acc_id, jid);
      const accCfg  = await getAccLLMConfig(acc_id);
      const finalText = renderTextTemplate(text, profile, accCfg) || undefined;

      // анти-дубль
      if (finalText && await hasRecentlySent(tenantId, acc_id, jid, finalText, 90)) {
        return res.json({ ok:true, dedup:true });
      }

      // media / text
      let mf = (media_file||'').replace(/^\/+/, '');
      let kind = req_kind === 'image' || req_kind === 'video' || req_kind === 'audio' || req_kind === 'document'
        ? req_kind
        : '';

      if (mf && kind) {
        await tgSendMediaFromUploads(token, chatId, kind, mf, finalText || '');
      } else if (finalText) {
        await tgSendLongText(token, chatId, finalText);
      } else {
        return res.status(400).json({ ok:false, error:'nothing to send' });
      }

      // лог в БД
      const ts = nowSec();
      const date = new Date(ts*1000).toISOString().slice(0,10);
      const extId = crypto.randomUUID();

      await run(
        `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,wa_id,crm_ext_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, jid, date, ts,
        finalText || (
          kind==='image' ? '🖼 Изображение' :
          kind==='gif' ? '🎞 GIF' :
          kind==='video' ? '🎬 Видео' :
          kind==='ptv' ? '⭕ Видео-кружок' :
          kind==='sticker' ? '🧩 Стикер' :
          kind==='audio' ? '🎤 Голосовое' :
          '📄 Документ'
        ),
        'out', acc_id, mf || '', kind || '', waOutId || null, extId]
      );

      io.to(`tenant_${tenantId}`).emit('newchat',{
        acc_id: acc_id,
        jid,
        phone: String(chatId),
        text: finalText || '',
        date,
        media_file: mf || '',
        media_kind: kind || ''
      });

      return res.json({ ok:true });
    }

    // если пытаются отправить через старый acc_id (не ready) — редиректим на активный online acc_id того же номера
    if ((accKind === 'wa' || accKind === 'whatsapp') && !await isAccReady(acc_id)) {
      const redirected = await resolveActiveWaAccId(tenantId, acc_id);
      if (redirected !== acc_id) acc_id = redirected;
    }

    // WHATSAPP (Baileys или WABA)
    // -------------------------------------------------
    const isWABA = await isWABAAccount(acc_id);

    // ВАЖНО: WABA не должен зависеть от isAccReady (это только для Baileys-сокета)
    if (!isWABA) {
      if (!await isAccReady(acc_id)) {
        return res.status(409).json({ ok:false, error:'WA_NOT_READY: connection is not open' });
      }
    }

    // рендер текста (шаблоны)
    const profile = await getProfile(acc_id, jid);
    const accCfg  = await getAccLLMConfig(acc_id);
    const finalText = renderTextTemplate(text, profile, accCfg) || undefined;

    // анти-дубль (двойной клик)
    if (finalText && await hasRecentlySent(tenantId, acc_id, jid, finalText, 90)) {
      return res.json({ ok:true, dedup:true });
    }

    // нормализация пути/типа
    let mf = (media_file || '').replace(/^\/+/, '');
    let kind = (
      req_kind === 'image' || req_kind === 'video' || req_kind === 'audio' || req_kind === 'document' ||
      req_kind === 'gif' || req_kind === 'sticker' || req_kind === 'ptv' || req_kind === 'video_note'
    )
      ? req_kind
      : '';

    if (kind === 'video_note') kind = 'ptv';

    // Auto-detect for "any file" mode
    if (!kind && mf) {
      const lower = String(mf).toLowerCase();
      if (lower.endsWith('.gif')) kind = 'gif';
      else if (lower.endsWith('.webp')) kind = 'sticker';
      else kind = inferKindFromPath(mf) || 'document';
    }

// -------------------------------------------------
    // 1) WABA (Meta Cloud API)
    // -------------------------------------------------
    if (isWABA) {
      console.log('[/api/send] Using WABA (Meta Cloud API)');

      await sendViaWABA(acc_id, jid, finalText, mf, kind);

      // лог в БД
      const ts   = nowSec();
      const date = new Date(ts * 1000).toISOString().slice(0,10);
      const extId = crypto.randomUUID();

      await run(
        `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          tenantId, jid, date, ts,
          finalText || (
          kind==='image' ? '🖼 Изображение' :
          kind==='gif' ? '🎞 GIF' :
          kind==='video' ? '🎬 Видео' :
          kind==='ptv' ? '⭕ Видео-кружок' :
          kind==='sticker' ? '🧩 Стикер' :
          kind==='audio' ? '🎤 Голосовое' :
          '📄 Документ'
        ),
          'out', acc_id, mf || '', kind || '', extId
        ]
      );

      await evaluateAndUpdateStage(acc_id, jid);

      await pushMessageToCRM({
        tenant_id: tenantId,
        acc_id,
        jid,
        direction: 'out',
        text: finalText || '',
        media_file: mf || '',
        media_kind: kind || '',
        external_id: extId
      });      // realtime в панель
      const phoneResolvedUi = await resolvePhoneForAccJid(acc_id, jid);
      io.to(`tenant_${tenantId}`).emit('newchat', {
        acc_id,
        jid,
        phone: phoneResolvedUi || '',
        type: 'out',
        ts,
        msg_ref: waOutId || '',
        wa_id: waOutId || '',
        text: finalText || (mf ? (
          kind==='image' ? '🖼 Изображение' :
          kind==='gif' ? '🎞 GIF' :
          kind==='video' ? '🎬 Видео' :
          kind==='ptv' ? '⭕ Видео-кружок' :
          kind==='sticker' ? '🧩 Стикер' :
          kind==='audio' ? '🎤 Голосовое' :
          '📄 Документ'
        ) : ''),
        date,
        media_file: toPublicMediaPath(mf || ''),
        media_kind: kind || ''
      });

      return res.json({ ok:true });
    }

    // -------------------------------------------------
    // 2) BAILEYS
    // -------------------------------------------------
    const sockEntry = sockets.get(acc_id);
    const sock = sockEntry?.sock;
    if (!sock) return res.status(409).json({ ok:false, error:'WA_NOT_READY: socket missing' });


    console.log(`[WA][SEND][BAILEYS] tid=${tenantId} acc=${acc_id} jid=${jid} len=${text?.length || 0}`);

    const abs = mf ? path.resolve(__dirname, mf) : '';

    // BAILEYS format (send + capture WA message id)
    let waOutId = '';
        const MAX_CAPTION = 900; // WA caption limit is ~1024; keep some margin
        const cap  = (finalText && finalText.length <= MAX_CAPTION) ? finalText : '';
        const tail = (finalText && !cap) ? finalText : '';

        // Fast check: file must exist if we are sending media
        if (mf && !fs.existsSync(abs)) return res.status(400).json({ok:false,error:'media not found'});

        if (mf && kind === 'image') {
          const buf = fs.readFileSync(abs);
          const sent = await sock.sendMessage(jid, { image: buf, caption: cap || undefined });
          waOutId = sent?.key?.id || '';
          if (tail) { await sleep(200); waOutId = await sendLongText(sock, jid, tail, tenantId, acc_id); }

        } else if (mf && kind === 'gif') {
          const buf = fs.readFileSync(abs);
          const sent = await sock.sendMessage(jid, { video: buf, gifPlayback: true, caption: cap || undefined });
          waOutId = sent?.key?.id || '';
          if (tail) { await sleep(200); waOutId = await sendLongText(sock, jid, tail, tenantId, acc_id); }

        } else if (mf && kind === 'video') {
          const buf = fs.readFileSync(abs);
          const sent = await sock.sendMessage(jid, { video: buf, caption: cap || undefined });
          waOutId = sent?.key?.id || '';
          if (tail) { await sleep(200); waOutId = await sendLongText(sock, jid, tail, tenantId, acc_id); }

        } else if (mf && kind === 'ptv') {
          const buf = fs.readFileSync(abs);
          const sent = await sock.sendMessage(jid, { video: buf, ptv: true });
          waOutId = sent?.key?.id || '';
          if (finalText) { await sleep(200); waOutId = await sendLongText(sock, jid, finalText, tenantId, acc_id); }

        } else if (mf && kind === 'sticker') {
          const buf = fs.readFileSync(abs);
          const sent = await sock.sendMessage(jid, { sticker: buf });
          waOutId = sent?.key?.id || '';
          if (finalText) { await sleep(200); waOutId = await sendLongText(sock, jid, finalText, tenantId, acc_id); }

        } else if (mf && kind === 'audio') {
          const meta = await normalizeAudioForWA(abs);
          const buf  = fs.readFileSync(meta.abs);
          const sent = await sock.sendMessage(jid, { audio: buf, mimetype: meta.mime, ptt: meta.ptt });
          waOutId = sent?.key?.id || '';
          if (finalText) { await sleep(200); waOutId = await sendLongText(sock, jid, finalText, tenantId, acc_id); }

        } else if (mf) {
          const sent = await sock.sendMessage(jid, {
            document: fs.createReadStream(abs),
            fileName: path.basename(abs),
            mimetype: 'application/octet-stream'
          });
          waOutId = sent?.key?.id || '';
          if (finalText) { await sleep(200); waOutId = await sendLongText(sock, jid, finalText, tenantId, acc_id); }

        } else if (finalText) {
          waOutId = await sendLongText(sock, jid, finalText, tenantId, acc_id);

        } else {
          return res.status(400).json({ok:false,error:'nothing to send'});
        }

    // лог в БД
    const ts   = nowSec();
    const date = new Date(ts * 1000).toISOString().slice(0,10);
    const extId = crypto.randomUUID();

    await run(
      `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,wa_id,crm_ext_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId, jid, date, ts,
        finalText || (
          kind==='image' ? '🖼 Изображение' :
          kind==='gif' ? '🎞 GIF' :
          kind==='video' ? '🎬 Видео' :
          kind==='ptv' ? '⭕ Видео-кружок' :
          kind==='sticker' ? '🧩 Стикер' :
          kind==='audio' ? '🎤 Голосовое' :
          '📄 Документ'
        ),
        'out', acc_id, mf || '', kind || '', extId
      ]
    );

    await evaluateAndUpdateStage(acc_id, jid);

    await pushMessageToCRM({
      tenant_id: tenantId,
      acc_id,
      jid,
      direction: 'out',
      text: finalText || '',
      media_file: mf || '',
      media_kind: kind || '',
      external_id: extId
    });
    const phoneResolvedUi = await resolvePhoneForAccJid(acc_id, jid);
    io.to(`tenant_${tenantId}`).emit('newchat', {
      acc_id,
      jid,
      phone: phoneResolvedUi || '',
      text: finalText || '',
      date,
      media_file: toPublicMediaPath(mf || ''),
      media_kind: kind || ''
    });

    return res.json({ ok:true });

    }catch(e){
        console.error('========================================');
        console.error('[/api/send] ERROR:', e.message);
        console.error('[/api/send] STACK:', e.stack);
        console.error('========================================');
        res.status(500).json({ok:false,error:e.message});
      }
  });

app.get('/api/escalations', authGuard, async (req,res)=>{ res.json(await all(`SELECT * FROM escalations WHERE tenant_id=? AND resolved=0 ORDER BY ts DESC LIMIT 200`, [req.user.tenant_id])); });
app.post('/api/escalations/:id/resolve', authGuard, async (req,res)=>{
  const row = await get(`SELECT tenant_id FROM escalations WHERE id=?`, [Number(req.params.id)]);
  if(!row || row.tenant_id!==req.user.tenant_id) return res.status(403).json({ok:false,error:'forbidden'});
  await run(`UPDATE escalations SET resolved=1 WHERE id=?`,[Number(req.params.id)]); res.json({ok:true});
});

// CRM → отправка сообщения в WA по lead_id из CRM
// CRM → отправка сообщения в WA по lead_id из CRM (переписанный, с code/логами)
app.post('/api/crm/send', async (req, res) => {
  const startedAt = Date.now();
  const hitMeta = {
    lead_id: req.body?.lead_id,
    hasAuth: !!(req.headers.authorization || req.headers.apikey),
    from: req.ip,
    ua: req.headers['user-agent'] || ''
  };
  console.log('[CRM→SEND][HIT]', hitMeta);

  // локальные утилиты
  const maskKey = (k='') => (k ? (k.slice(0,4) + '…' + k.slice(-2)) : '');
  const jsonErr = (res, http, code, error, extra={}) => {
    const payload = { ok:false, code, error, ...extra };
    console.warn('[CRM→SEND][ERR]', { code, error, extra, took_ms: Date.now()-startedAt });
    return res.status(http).json(payload);
  };

  try {
    // --- auth из заголовков ---
    const hdr  = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const hdr2 = String(req.headers.apikey || '').trim();
    const auth = hdr || hdr2;
    console.log('[CRM→SEND][AUTH]', { auth: maskKey(auth) });

    const {
      lead_id,
      phone,
      text,
      media_url,
      media_type,   // 'image' | 'video' | 'audio' | 'document'
      media_file,   // 'uploads/xxx.ext' (опционально — локальный файл)
      media_kind    // дубликат media_type (на всякий случай)
    } = req.body || {};

    // валидация входа
    const textSafe = String(text || '').trim();
    if ((!lead_id && !phone) || (!textSafe && !media_url && !media_file)) {
      return jsonErr(res, 400, 'INVALID_INPUT',
        'lead_id OR phone is required, and also text or media');
    }

    // 1) tenant по api_key из settings
    const rowTid = await get(
      `SELECT tenant_id FROM settings WHERE key='crm_api_key' AND value=? LIMIT 1`,
      [auth]
    );
    if (!rowTid?.tenant_id) {
      return jsonErr(res, 403, 'BAD_API_KEY', 'forbidden (bad api key)');
    }
    const tenantIdForKey = Number(rowTid.tenant_id);
    console.log('[CRM→SEND][TENANT_FOR_KEY]', { tenant_id: tenantIdForKey });

    // 2) профиль по crm_id
    let prof = null;
    if (lead_id) {
      prof = await get(
        `SELECT tenant_id, acc_id, jid FROM profiles WHERE crm_id=?`,
        [String(lead_id)]
      );

      if (prof) console.log('[CRM→SEND][PROFILE_BY_LEAD]', { tenant_id: prof.tenant_id, acc_id: prof.acc_id, jid: prof.jid });

    }

    // 3) не нашли — по телефону
    let normDigits = '';
    if (!prof && phone) {
      normDigits = String(phone).replace(/[^\d]/g, '');
      const jidGuess = normDigits ? (normDigits + '@s.whatsapp.net') : '';
      if (jidGuess) {
        prof = await get(
          `SELECT tenant_id, acc_id, jid FROM profiles WHERE tenant_id=? AND jid=? LIMIT 1`,
          [tenantIdForKey, jidGuess]
        );
        if (prof) console.log('[CRM→SEND][PROFILE_BY_PHONE]', { tenant_id: prof.tenant_id, acc_id: prof.acc_id, jid: prof.jid });
      }
    }

    // 4) всё ещё нет — создаём профиль на лету, подвешиваем к любому аккаунту тенанта
    if (!prof) {
      let acc = await get(`SELECT id FROM accounts WHERE tenant_id=? AND status='online' LIMIT 1`, [tenantIdForKey]);
      if (!acc) acc = await get(`SELECT id FROM accounts WHERE tenant_id=? ORDER BY id LIMIT 1`, [tenantIdForKey]);
      if (!acc) return jsonErr(res, 400, 'NO_ACCOUNTS', 'no accounts for tenant');

      if (!normDigits) {
        if (!phone) return jsonErr(res, 404, 'LEAD_NOT_LINKED', 'lead not linked and phone missing');
        normDigits = String(phone).replace(/[^\d]/g, '');
      }
      if (!normDigits || normDigits.length < 8 || normDigits.length > 15) {
        return jsonErr(res, 400, 'BAD_PHONE', 'bad phone');
      }

      const newJid = normDigits + '@s.whatsapp.net';
      await saveProfile(acc.id, newJid, { crm_id: lead_id ? String(lead_id) : '' });
      prof = { tenant_id: tenantIdForKey, acc_id: acc.id, jid: newJid };
      console.log('[CRM→SEND][PROFILE_CREATED]', { acc_id: acc.id, jid: newJid });
    }

    // 5) финальная проверка ключа именно этого тенанта
    const row = await get(`SELECT value FROM settings WHERE tenant_id=? AND key='crm_api_key'`, [prof.tenant_id]);
    const apiKey = String(row?.value || '').trim();
    if (!apiKey || apiKey !== auth) {
      return jsonErr(res, 403, 'TENANT_MISMATCH', 'forbidden (tenant mismatch)');
    }

    // если профиль привязан к старому acc_id — редиректим на активный acc_id того же номера
    {
      const fromId = Number(prof.acc_id);
      const toId = await resolveActiveWaAccId(prof.tenant_id, fromId);
      if (toId !== fromId) {
        console.log('[CRM→SEND][ACC_REDIRECT]', { from: fromId, to: toId });
        prof.acc_id = toId;
      }
    }

    // 6) анти-дедуп по тексту из CRM (90 секунд)
    if (textSafe && await hasRecentlySent(prof.tenant_id, Number(prof.acc_id), prof.jid, textSafe, 90)) {
      console.log('[CRM→SEND][DEDUP]', { accId: prof.acc_id, jid: prof.jid, text: textSafe });
      return res.json({ ok: true, dedup: true, code: 'DEDUP_90S' });
    }

    // 6.5) Канал-специфика (IG/WABA): отправляем без Baileys-сокета
    {
      const accIdNum = Number(prof.acc_id);
      const accKind = await getAccKind(accIdNum);
      const jidStr = String(prof.jid || '').trim();

      // --- Instagram ---
      if (accKind === 'ig' || jidStr.startsWith('ig:')) {
        const threadId = jidStr.replace(/^ig:/, '').trim();
        if (!threadId || !/^\d+$/.test(threadId)) {
          return jsonErr(res, 400, 'IG_BAD_THREAD', 'IG thread id is invalid');
        }

        const conn = await get(
          `SELECT access_token FROM ig_connections WHERE tenant_id=? ORDER BY connected_at DESC LIMIT 1`,
          [prof.tenant_id]
        );
        const token = String(conn?.access_token || '').trim();
        if (!token) return jsonErr(res, 409, 'IG_NOT_CONFIGURED', 'IG is not configured for this tenant');

        if (!textSafe) return jsonErr(res, 400, 'IG_TEXT_REQUIRED', 'Instagram supports text only in this endpoint');

        await igSendLongText(token, threadId, textSafe);
        await run(
          `INSERT INTO ig_chats(tenant_id,thread_id,from_id,ts,direction,text,raw_json)
           VALUES(?,?,?,?,?,?,?)`,
          [prof.tenant_id, threadId, 'me', Date.now(), 'out', textSafe, JSON.stringify({ source:'crm' }).slice(0, 200000)]
        );

        try {
          const date = new Date().toISOString().slice(0,10);
          io.to(`tenant_${prof.tenant_id}`).emit('newchat', {
            acc_id: accIdNum,
            jid: `ig:${threadId}`,
            phone: threadId,
            type: 'out',
            ts: Math.floor(Date.now()/1000),
            text: textSafe,
            date
          });
        } catch(_) {}

        return res.json({ ok:true, platform:'instagram' });
      }

      // --- WhatsApp Cloud API (WABA) ---
      if (await isWABAAccount(accIdNum)) {
        const mUrlIn  = String(media_url || '').trim();
        const mFileIn = String(media_file || '').trim();
        const kindIn  = String(media_type || media_kind || '').toLowerCase().trim();
        const pick = (v) => (v && String(v).trim()) ? String(v).trim() : '';
        const mediaIn = pick(mFileIn) || pick(mUrlIn);

        const kindFromExt = (p='') => {
          const ext = (path.extname((p || '').split('?')[0]) || '').toLowerCase();
          if (['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)) return 'image';
          if (['.mp4','.mov','.avi','.mkv','.webm'].includes(ext)) return 'video';
          if (['.ogg','.opus','.m4a','.mp3','.webm'].includes(ext)) return 'audio';
          return 'document';
        };

        const sendKind = kindIn || (mediaIn ? kindFromExt(mediaIn) : '');

        await sendViaWABA(accIdNum, jidStr, textSafe, mediaIn, sendKind);

        const tsNow = Math.floor(Date.now()/1000);
        const date = new Date().toISOString().slice(0,10);
        const extId = crypto.randomUUID();
        await run(
          `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [prof.tenant_id, jidStr, date, tsNow, textSafe || '', 'out', accIdNum, mediaIn || '', sendKind || '', extId]
        );

        await pushMessageToCRM({
          tenant_id: prof.tenant_id,
          acc_id: accIdNum,
          jid: jidStr,
          direction: 'out',
          text: textSafe || '',
          media_file: mediaIn || '',
          media_kind: sendKind || '',
          external_id: extId
        });

        try {
          const phoneResolvedUi = await resolvePhoneForAccJid(accIdNum, jidStr);
          io.to(`tenant_${prof.tenant_id}`).emit('newchat', {
            acc_id: accIdNum,
            jid: jidStr,
            phone: phoneResolvedUi || '',
            type: 'out',
            ts: tsNow,
            text: textSafe || '',
            media_file: toPublicMediaPath(mediaIn || ''),
            media_kind: sendKind || '',
            date
          });
        } catch(_) {}

        return res.json({ ok:true, platform:'whatsapp', waba:true });
      }
    }

    // 7) проверяем соединение WA
    if (!await isAccReady(Number(prof.acc_id))) {
      return jsonErr(res, 409, 'WA_NOT_READY', 'WA_NOT_READY: connection is not open');
    }
    const sockEntry = sockets.get(Number(prof.acc_id));
    const sock = sockEntry.sock;
    console.log(`[CRM→SEND][ENGINE] BAILEYS for acc ${prof.acc_id}`);

    // --- нормализуем медиа-инпут ---
    const mUrlIn  = String(media_url || '').trim();
    let   mKind   = (media_type || media_kind || '').toLowerCase().trim();
    const mFileIn = String(media_file || '').trim(); // локальный путь ('uploads/...')
    const hasMedia = !!(mUrlIn || mFileIn);

    // helper: по расширению -> тип медиа
    const kindFromExt = (p='') => {
      const ext = (path.extname((p || '').split('?')[0]) || '').toLowerCase();
      if (['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)) return 'image';
      if (['.mp4','.mov','.avi','.mkv','.webm'].includes(ext)) return 'video';
      if (['.ogg','.opus','.m4a','.mp3','.webm'].includes(ext)) return 'audio';
      return 'document';
    };

    // отправка локального файла (uploads/..)
    const sendLocalMedia = async (abs, kind) => {
      if (!fs.existsSync(abs)) {
        console.warn('[CRM→SEND][MEDIA_LOCAL_MISSING]', { abs });
        throw new Error('media file not found: ' + abs);
      }
      
      const buf = fs.readFileSync(abs);
      

      // Baileys формат: Buffer
      if (kind === 'image') {
        await sock.sendMessage(prof.jid, { image: buf });
        if (textSafe) { await sleep(200); await sock.sendMessage(prof.jid, { text: textSafe }); }
        return { savedFile: 'uploads/' + path.basename(abs), savedKind: 'image' };
      }
      if (kind === 'video') {
        await sock.sendMessage(prof.jid, { video: buf });
        if (textSafe) { await sleep(200); await sock.sendMessage(prof.jid, { text: textSafe }); }
        return { savedFile: 'uploads/' + path.basename(abs), savedKind: 'video' };
      }
      if (kind === 'audio') {
        // нормализуем для WA
        const meta = await normalizeAudioForWA(abs);
        const buf2 = fs.readFileSync(meta.abs);
        await sock.sendMessage(prof.jid, { audio: buf2, mimetype: meta.mime, ptt: meta.ptt });
        const absM4A = await safeMakePreviewM4A(meta.abs);
        return { savedFile: 'uploads/' + path.basename(absM4A), savedKind: 'audio' };
      }
      // document
      await sock.sendMessage(prof.jid, { document: buf, fileName: path.basename(abs) });
      if (textSafe) { await sleep(200); await sock.sendMessage(prof.jid, { text: textSafe }); }
      return { savedFile: 'uploads/' + path.basename(abs), savedKind: 'document' };
    };

    // отправка по URL
    const sendUrlMedia = async (url, kind) => {
      if (kind === 'image') {
        await sock.sendMessage(prof.jid, { image: { url }, caption: textSafe || '' });
        return { savedFile: url, savedKind: 'image' };
      }
      if (kind === 'video') {
        await sock.sendMessage(prof.jid, { video: { url }, caption: textSafe || '' });
        return { savedFile: url, savedKind: 'video' };
      }
      if (kind === 'audio') {
        // скачиваем → нормализуем → отправляем как voice/audio
        const resp = await fetchWithTimeout(url, {}, 30000);
        if (!resp.ok) {
          console.warn('[CRM→SEND][MEDIA_FETCH_FAIL]', { url, status: resp.status });
          throw new Error('media fetch failed: ' + resp.status);
        }
        const extIn = path.extname(url.split('?')[0] || '').toLowerCase() || '.bin';
        const tmpIn = path.join(UPLOAD_DIR, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${extIn}`);
        await fsp.writeFile(tmpIn, Buffer.from(await resp.arrayBuffer()));

        const meta = await normalizeAudioForWA(tmpIn);
        const buf  = fs.readFileSync(meta.abs);
        await sock.sendMessage(prof.jid, { audio: buf, mimetype: meta.mime, ptt: meta.ptt });

        const absM4A = await safeMakePreviewM4A(meta.abs);
        const relM4A = 'uploads/' + path.basename(absM4A);

        try { await fsp.rm(tmpIn, { force:true }); } catch(_){}
        try { if (meta.abs !== tmpIn) await fsp.rm(meta.abs, { force:true }); } catch(_){}

        return { savedFile: relM4A, savedKind: 'audio' };
      }
      // document (если URL приватный — WA сам не скачает; это на совести отправителя)
      await sock.sendMessage(prof.jid, {
        document: { url },
        fileName: (textSafe || 'file'),
        mimetype: 'application/octet-stream'
      });
      return { savedFile: url, savedKind: 'document' };
    };

    // --- отправка ---
    let savedFile = '';
    let savedKind = '';

    if (hasMedia) {
      // определяем тип
      if (!mKind) mKind = kindFromExt(mFileIn || mUrlIn);

      if (mFileIn) {
        // локальный файл
        const rel = mFileIn.replace(/^\/+/, '');
        const abs = path.resolve(__dirname, rel);
        const kind = mKind || kindFromExt(rel);
        const s = await sendLocalMedia(abs, kind);
        savedFile = s.savedFile;
        savedKind = s.savedKind;
      } else {
        // URL
        const kind = mKind || kindFromExt(mUrlIn);
        const s = await sendUrlMedia(mUrlIn, kind);
        savedFile = s.savedFile;
        savedKind = s.savedKind;
      }
    } else if (textSafe) {
      // только текст
      await sendLongText(sock, prof.jid, textSafe, prof.tenant_id);
    }

    // --- лог в БД ---
    const ts   = nowSec();
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const extId = crypto.randomUUID();

    await run(
      `INSERT INTO chats(tenant_id,jid,date,ts,message,type,acc_id,media_file,media_kind,crm_ext_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [prof.tenant_id, prof.jid, date, ts,
      String(textSafe || ''), 'out', prof.acc_id, savedFile || '', savedKind || '', extId]
    );

    // --- пуш события в CRM-таймлайн (если настроено) ---
    try {
      await pushMessageToCRM({
        tenant_id: prof.tenant_id,
        acc_id: prof.acc_id,
        jid: prof.jid,
        direction: 'out',
        text: String(textSafe || ''),
        media_file: savedFile || '',
        media_kind: savedKind || '',
        external_id: extId
      });
    } catch (e) {
      // не ломаем основной поток, но логируем
      console.warn('[CRM→SEND][CRM_TIMELINE_PUSH_FAIL]', String(e?.message || e));
    }

    const took = Date.now() - startedAt;
    console.log('[CRM→SEND][OK]', { acc_id: prof.acc_id, jid: prof.jid, savedKind, took_ms: took });
    return res.json({ ok: true, code: 'SENT', dedup: false, took_ms: took });
  } catch (e) {
    console.error('[CRM→SEND] error', e);
    const msg = String(e?.message || e || 'internal error');
    // нормализуем типовые ошибки WA, чтобы фронт мог читать code
    if (/WA_NOT_READY/i.test(msg)) {
      return res.status(409).json({ ok:false, code:'WA_NOT_READY', error: msg });
    }
    if (/bad phone/i.test(msg)) {
      return res.status(400).json({ ok:false, code:'BAD_PHONE', error: msg });
    }
    if (/media fetch failed/i.test(msg)) {
      return res.status(500).json({ ok:false, code:'MEDIA_FETCH_FAIL', error: msg });
    }
    return res.status(500).json({ ok:false, code:'INTERNAL_ERROR', error: msg });
  }
});

// =====================================================
// CRM (SatuBooster) helper endpoints for NeDzat UI
// =====================================================

app.post('/api/crm/bootstrap', authGuard, async (req, res) => {
  try {
    const tenantId = String(req.user?.tenant_id || '');
    const base = String(req.body?.crm_base || '').trim().replace(/\/+$/,'');
    const apiKey = String(req.body?.api_key || '').trim();

    if (!tenantId || !base || !apiKey) {
      return res.status(400).json({ error: 'crm_base and api_key are required' });
    }

    const url = base.endsWith('/functions/v1') ? `${base}/nedzat-bootstrap` : `${base}/functions/v1/nedzat-bootstrap`;
    const r = await fetchWithTimeout(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ api_key: apiKey })
    }, 15000);

    const txt = await r.text().catch(()=> '');
    let js = {};
    try { js = JSON.parse(txt || '{}'); } catch { js = { raw: txt }; }

    if (!r.ok) return res.status(r.status).json(js);

    // сохраняем в settings, чтобы пуши работали без ручных полей
    const companyId = String(js.company_id || '');
    const webhook = String(js.webhooks?.message_webhook || '');

    await setSetting('crm_base', base.endsWith('/functions/v1') ? base : (base + '/functions/v1'), tenantId);
    await setSetting('crm_company_api_key', apiKey, tenantId);

    if (companyId) await setSetting('crm_company_id', companyId, tenantId);
    if (webhook) {
      await setSetting('crm_endpoint', webhook, tenantId);
      await setSetting('crm_msg_endpoint', webhook, tenantId);
    }

    return res.json(js);
  } catch (e) {
    return res.status(500).json({ error:'bootstrap failed', details: e?.message || String(e) });
  }
});

app.post('/api/crm/account-upsert', authGuard, async (req, res) => {
  try {
    const tenantId = String(req.user?.tenant_id || '');
    const account_id = String(req.body?.account_id || '').trim();
    const platform = String(req.body?.platform || '').trim();
    const pipeline_id = req.body?.pipeline_id || null;
    const default_stage_id = req.body?.default_stage_id || null;

    if (!tenantId || !account_id || !platform) {
      return res.status(400).json({ error:'account_id and platform are required' });
    }

    const base = String((await getSetting('crm_base', tenantId)) || '').trim().replace(/\/+$/,'');
    const apiKey = String((await getSetting('crm_company_api_key', tenantId)) || '').trim();
    if (!base || !apiKey) {
      return res.status(400).json({ error:'CRM not connected (missing crm_base/crm_company_api_key)' });
    }

    const url = `${base}/nedzat-accounts-upsert`;
    const payload = {
      api_key: apiKey,
      tenant_id: tenantId,
      account_id,
      platform,
      pipeline_id,
      default_stage_id
    };

    const r = await fetchWithTimeout(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }, 15000);

    const txt = await r.text().catch(()=> '');
    res.status(r.status).type('application/json').send(txt || '{}');
  } catch (e) {
    return res.status(500).json({ error:'upsert failed', details: e?.message || String(e) });
  }
});

// === Реакции (визуально как WhatsApp Web) ===
app.post('/api/react', authGuard, async (req,res)=>{
  try{
    const acc_id = Number(req.body?.acc_id);
    const jidRaw = String(req.body?.jid||'').trim();
    const msg_ref = String(req.body?.msg_ref||'').trim();
    const emoji = String(req.body?.emoji||'').trim();

    if (!acc_id || !jidRaw || !msg_ref || !emoji) return res.status(400).json({ ok:false, error:'acc_id, jid, msg_ref, emoji required' });
    if (emoji.length > 12) return res.status(400).json({ ok:false, error:'bad emoji' });
    if (!await ensureOwnAccountOrHistory(req, acc_id)) return res.status(403).json({ ok:false, error:'forbidden' });

    const tenantId = await getAccTenant(acc_id);
    const accKind = await getAccKind(acc_id);

    let jid = jidRaw;
    if (accKind === 'ig'){
      const threadId = jidRaw.startsWith('ig:') ? jidRaw.slice(3) : jidRaw;
      jid = `ig:${threadId}`;
    } else if (accKind === 'tg'){
      jid = normalizeTgJid(jidRaw);
    } else {
      jid = normalizeDirectJid(jidRaw);
    }
    if (!jid) return res.status(400).json({ ok:false, error:'bad jid' });

    const next = await upsertReactionToggle(tenantId, acc_id, jid, msg_ref, emoji);

    // ✅ синхронизация реакции в сам WhatsApp (чтобы собеседник увидел, как в приложении)
    try{
      const data = safeJsonParse(next, { e: [] }) || { e: [] };
      const isOn = Array.isArray(data.e) && data.e.includes(emoji);

      if (await isWABAAccount(acc_id)) {
        await sendReactionViaWABA(acc_id, jid, msg_ref, isOn ? emoji : '');
      } else {
        // Baileys (WA-Web)
        if (await isAccReady(acc_id)) {
          const sockWrap = sockets.get(acc_id);
          const sock = sockWrap?.sock || sockWrap;
          if (sock && sock.sendMessage) {
            await sock.sendMessage(jid, {
              react: {
                text: isOn ? emoji : '',
                key: { remoteJid: jid, fromMe: false, id: msg_ref }
              }
            });
          }
        }
      }
    }catch(e){
      console.warn('[REACTION] send to platform failed:', e?.message || e);
    }

    io.to(`tenant_${tenantId}`).emit('reaction:update', {
      acc_id, jid, msg_ref,
      reactions_json: next
    });

    res.json({ ok:true, reactions_json: next });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// === Chats: history ===
app.get('/api/chats/history', authGuard, async (req,res)=>{
  try{
    const acc_id = Number(req.query.acc_id);
    const jidRaw  = String(req.query.jid||'').trim();
    const limit  = Math.min(400, Math.max(20, parseInt(req.query.limit||'120',10)));
    const before = parseInt(req.query.before||'0',10) || 0;

    if (!acc_id || !jidRaw) return res.status(400).json({ok:false,error:'acc_id & jid required'});
    if (!await ensureOwnAccountOrHistory(req, acc_id)) return res.status(403).json({ok:false,error:'forbidden'});

    const accKind = await getAccKind(acc_id);

    // === Instagram ===
    if (accKind === 'ig'){
      const tenantId = await getAccTenant(acc_id);
      const threadId = jidRaw.startsWith('ig:') ? jidRaw.slice(3) : jidRaw;
      if (!threadId) return res.status(400).json({ ok:false, error:'bad ig jid' });

      const params = [tenantId, threadId];
      let sql = `SELECT id, ts, direction AS type, text AS message,
                        '' AS media_file, '' AS media_kind,
                        NULL AS prompt_tokens, NULL AS completion_tokens, NULL AS total_tokens, NULL AS model, NULL AS cost_usd
                FROM ig_chats
                WHERE tenant_id=? AND thread_id=?`;
      if (before > 0){ sql += ` AND ts < ?`; params.push(before); }
      sql += ` ORDER BY ts DESC LIMIT ?`; params.push(limit);

      const rows = await all(sql, params);
      rows.reverse();
      return res.json(rows);
    }

    // === Telegram / WhatsApp (stored in `chats`) ===
    const jidNorm = (accKind === 'tg') ? normalizeTgJid(jidRaw) : normalizeDirectJid(jidRaw);
    if (!jidNorm) return res.status(400).json({ ok:false, error:'bad jid' });

    const params = [req.user.tenant_id, acc_id, jidNorm];
    let sql = `SELECT id, ts, type, message, media_file, media_kind, wa_id,
                      media_name, media_mime, media_size,
                      prompt_tokens, completion_tokens, total_tokens, model, cost_usd

               FROM chats WHERE tenant_id=? AND acc_id=? AND jid=?`;
    if (before > 0){ sql += ` AND ts < ?`; params.push(before); }
    sql += ` ORDER BY ts DESC, id DESC LIMIT ?`; params.push(limit);

    const rows = await all(sql, params);
    rows.reverse();

    // UI needs public URL for media
    for (const r of rows) {
      if (r && r.media_file) r.media_file = toPublicMediaPath(r.media_file);
    }

    await attachReactionsToRows(req.user.tenant_id, acc_id, jidNorm, rows);

    res.json(rows);
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// === CRM API KEY: получить / сгенерировать / пример curl ===
app.get('/api/crm/api_key', authGuard, async (req, res) => {
  try {
    const key = await ensureCrmApiKey(req.user.tenant_id);
    // маска для логов
    const masked = key.slice(0, 4) + '…' + key.slice(-2);
    res.json({ ok:true, api_key: key, masked });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/crm/api_key/rotate', authGuard, async (req, res) => {
  try {
    const newKey = crypto.randomUUID();
    await setSetting('crm_api_key', newKey, req.user.tenant_id);
    res.json({ ok:true, api_key: newKey });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/crm/curl_example', authGuard, async (req, res) => {
  try {
    const key = await ensureCrmApiKey(req.user.tenant_id);
    const base = getPublicBaseUrl();
    const body = {
      phone: '77001234567',
      text:  'тест из curl (прямой вызов)',
    };
    const curl = [
      'curl -i ' + `${base}/api/crm/send`,
      '-H "Content-Type: application/json"',
      `-H "Authorization: Bearer ${key}"`,
      `-d '${JSON.stringify(body)}'`
    ].join(' \\\n  ');
    res.json({ ok:true, curl, api_key:key });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// -------------------------------------------------
// API: Export — CHATS
// -------------------------------------------------
app.get('/api/export/chats.xlsx', authGuard, async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const accId = req.query.acc_id ? Number(req.query.acc_id) : null;
    const jid = (req.query.jid || '').toString().trim();
    const dateFrom = (req.query.date_from || '').toString().trim(); // '2025-01-01' или ISO
    const dateTo   = (req.query.date_to   || '').toString().trim();

    if (accId && !await ensureOwnAccount(req, accId)) {
      return res.status(403).json({ ok:false, error: 'forbidden' });
    }

    // Временной фильтр
    const toTs = s => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(+d)) return null;
      return Math.floor(d.getTime()/1000);
    };
    const tsFrom = toTs(dateFrom);
    const tsTo   = toTs(dateTo);

    const params = [tid];
    let sql = `
      SELECT c.ts, c.type, c.acc_id, c.jid, c.message, c.media_kind, c.media_file, c.wa_id,
             p.name AS profile_name, a.label AS acc_label
      FROM chats c
      LEFT JOIN profiles p ON p.tenant_id=c.tenant_id AND p.acc_id=c.acc_id AND p.jid=c.jid
      LEFT JOIN accounts a ON a.id=c.acc_id
      WHERE c.tenant_id=?`;

    if (accId) { sql += ` AND c.acc_id=?`; params.push(accId); }
    if (jid)   { sql += ` AND c.jid=?`;    params.push(jid); }
    if (tsFrom){ sql += ` AND c.ts>=?`;    params.push(tsFrom); }
    if (tsTo)  { sql += ` AND c.ts<=?`;    params.push(tsTo); }

    sql += ` ORDER BY c.ts ASC LIMIT 100000`; // safety-лимит

    const rows = await all(sql, params);

    // Базовый URL для сборки ссылок на медиа
    const base = getPublicBaseUrl();

    const header = [
      'Datetime (UTC)', 'Direction', 'Account', 'Phone', 'Name',
      'Text', 'Media Kind', 'Media URL', 'WA Message ID'
    ];

    const table = [header];

    for (const r of rows) {
      const dt = new Date((Number(r.ts)||0)*1000).toISOString().replace('T',' ').replace('Z','');
      const phone = jidToPhone(r.jid || '');
      const mediaUrl = (r.media_file && base && !/^https?:\/\//i.test(r.media_file))
        ? `${base}/${String(r.media_file).replace(/^\/+/,'')}`
        : (r.media_file || '');

      table.push([
        dt,
        r.type === 'in' ? 'IN' : 'OUT',
        r.acc_label || r.acc_id || '',
        phone,
        r.profile_name || '',
        r.message || '',
        r.media_kind || '',
        mediaUrl,
        r.wa_id || ''
      ]);
    }

    const wb = XLSX.utils.book_new();
    const ws = aoaToSheetWithAutowidth(table);
    XLSX.utils.book_append_sheet(wb, ws, 'Chats');

    sendWorkbook(res, wb, 'chats.xlsx');
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// -------------------------------------------------
// API: Export — RECEIPTS
// -------------------------------------------------
app.get('/api/export/receipts.xlsx', authGuard, async (req, res) => {
  try {
    const tid = req.user.tenant_id;
    const accId = req.query.acc_id ? Number(req.query.acc_id) : null;
    const jid = (req.query.jid || '').toString().trim();
    const dateFrom = (req.query.date_from || '').toString().trim();
    const dateTo   = (req.query.date_to   || '').toString().trim();

    if (accId && !await ensureOwnAccount(req, accId)) {
      return res.status(403).json({ ok:false, error: 'forbidden' });
    }

    const toTs = s => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(+d)) return null;
      return Math.floor(d.getTime()/1000);
    };
    const tsFrom = toTs(dateFrom);
    const tsTo   = toTs(dateTo);

    const params = [tid];
    let sql = `
      SELECT r.ts, r.acc_id, r.jid, r.amount, r.currency, r.file, r.raw_text,
             p.name AS profile_name, a.label AS acc_label
      FROM receipts r
      LEFT JOIN profiles p ON p.tenant_id=r.tenant_id AND p.acc_id=r.acc_id AND p.jid=r.jid
      LEFT JOIN accounts a ON a.id=r.acc_id
      WHERE r.tenant_id=?`;
    if (accId){ sql += ` AND r.acc_id=?`; params.push(accId); }
    if (jid)  { sql += ` AND r.jid=?`;    params.push(jid); }
    if (tsFrom){ sql += ` AND r.ts>=?`;   params.push(tsFrom); }
    if (tsTo)  { sql += ` AND r.ts<=?`;   params.push(tsTo); }
    sql += ` ORDER BY r.ts DESC LIMIT 50000`;

    const rows = await all(sql, params);
    const base = getPublicBaseUrl();

    const header = ['Datetime (UTC)', 'Account', 'Phone', 'Name', 'Amount', 'Currency', 'File URL', 'Raw OCR (trimmed)'];
    const table = [header];

    for (const r of rows) {
      const dt = new Date((Number(r.ts)||0)*1000).toISOString().replace('T',' ').replace('Z','');
      const phone = jidToPhone(r.jid || '');
      const fileUrl = (r.file && base && !/^https?:\/\//i.test(r.file))
        ? `${base}/${String(r.file).replace(/^\/+/,'')}`
        : (r.file || '');

      table.push([
        dt,
        r.acc_label || r.acc_id || '',
        phone,
        r.profile_name || '',
        (isFinite(r.amount) ? Number(r.amount) : ''),
        r.currency || '',
        fileUrl,
        String(r.raw_text || '').slice(0, 5000)
      ]);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, aoaToSheetWithAutowidth(table), 'Receipts');
    sendWorkbook(res, wb, 'receipts.xlsx');
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// -------------------------------------------------
// API: Export — PROFILES
// -------------------------------------------------
app.get('/api/export/profiles.xlsx', authGuard, async (req, res) => {
  try {
    const tid   = req.user.tenant_id;
    const accId = req.query.acc_id ? Number(req.query.acc_id) : null;
    const q     = (req.query.q || '').toString().trim().toLowerCase();
    const stage = (req.query.stage || '').toString().trim();

    if (accId && !await ensureOwnAccount(req, accId)) {
      return res.status(403).json({ ok:false, error: 'forbidden' });
    }

    const params = [tid];
    let sql = `
      SELECT acc_id, jid, name, city, budget, interest, stage, last_intent, crm_id, crm_url, summary
      FROM profiles
      WHERE tenant_id=?`;
    if (accId){ sql += ` AND acc_id=?`; params.push(accId); }
    if (stage){ sql += ` AND stage=?`; params.push(stage); }
    if (q){
      sql += ` AND (LOWER(jid) LIKE ? OR LOWER(name) LIKE ? OR LOWER(city) LIKE ? OR LOWER(budget) LIKE ? OR LOWER(interest) LIKE ? OR LOWER(stage) LIKE ?)`;
      const pat = `%${q}%`; params.push(pat,pat,pat,pat,pat,pat);
    }
    sql += ` ORDER BY acc_id, jid LIMIT 100000`;

    const rows = await all(sql, params);

    const header = ['Account', 'Phone', 'Name', 'City', 'Budget', 'Interest', 'Stage', 'Last Intent', 'CRM ID', 'CRM URL', 'Summary'];
    const table = [header];

    for (const r of rows) {
      table.push([
        r.acc_id || '',
        jidToPhone(r.jid || ''),
        r.name || '',
        r.city || '',
        r.budget || '',
        r.interest || '',
        r.stage || '',
        r.last_intent || '',
        r.crm_id || '',
        r.crm_url || '',
        (r.summary || '').slice(0, 2000)
      ]);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, aoaToSheetWithAutowidth(table), 'Profiles');
    sendWorkbook(res, wb, 'profiles.xlsx');
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// -------------------------------------------------
// Socket.IO auth + rooms
// -------------------------------------------------
io.use((socket, next)=>{
  try{
    const bearer = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i,'') || '';
    let tok = bearer;
    if(!tok){
      const cookie = socket.request.headers.cookie||'';
      tok = cookie.replace(/(?:(?:^|.*;\s*)token\s*=\s*([^;]*).*$)|^.*$/, "$1");
    }
    const p = jwt.verify(tok, JWT_SECRET);
    socket.user = { id:p.uid, tenant_id:p.tid, role:p.role, email:p.email };
    return next();
  }catch(e){ return next(new Error('unauthorized')); }
});

io.on('connection', async (socket)=>{
  const tid = socket.user.tenant_id;
  socket.join(`tenant_${tid}`);
  socket.join(`user_${socket.user.id}`);

  // при подключении просто отдаём список аккаунтов
  // без автопоказа старых QR
  socket.emit('acc:list', await listAccountsByTenant(tid));
});

const BOOT = { started_at: Date.now(), ready: false, error: null };

app.get('/healthz', (_req, res) => {
  const code = BOOT.ready ? 200 : 503;
  res.status(code).json({
    ok: BOOT.ready,
    ready: BOOT.ready,
    uptime_sec: Math.round(process.uptime()),
    boot_error: BOOT.error ? String(BOOT.error).slice(0, 2000) : null,
  });
});

// ⭐ API: Сохранение Push Subscription
app.post('/api/push/subscribe', authGuard, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const subscription = JSON.stringify(req.body);
    
    await run(
      `UPDATE users SET push_subscription = ? WHERE tenant_id = ?`,
      [subscription, tenantId]
    );
    
    console.log(`[PUSH] Subscription saved for tenant ${tenantId}`);
    res.json({ ok: true });
  } catch(err) {
    console.error('[PUSH] Subscribe error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// -------------------------------------------------
// Bootstrap
// -------------------------------------------------

// ===================================================================
// WABA WEBHOOK - Получение сообщений от Meta
// ===================================================================
app.get('/waba/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  const verifyToken = process.env.WABA_WEBHOOK_VERIFY_TOKEN || 'change_me';
  
  console.log('[WABA][WEBHOOK] Verification:', { mode, token });
  
  const result = WABAClient.verifyWebhook(mode, token, challenge, verifyToken);
  if (result) {
    console.log('[WABA][WEBHOOK] ✅ Verified');
    return res.status(200).send(result);
  }
  
  console.warn('[WABA][WEBHOOK] ❌ Failed');
  return res.status(403).send('Forbidden');
});

app.post('/waba/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WABA][WEBHOOK] Received:', JSON.stringify(body).slice(0, 500));
    
    res.status(200).send('EVENT_RECEIVED');
    
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages') {
            const value = change.value;
            
            for (const message of value.messages || []) {
              await handleWABAIncoming(message, value.metadata).catch(e => {
                console.error('[WABA] Handle error:', e);
              });
            }
            
            for (const status of value.statuses || []) {
              await handleWABAStatus(status).catch(e => {
                console.error('[WABA] Status error:', e);
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[WABA][WEBHOOK] Error:', error);
    res.status(200).send('ERROR');
  }
});

// ===================================================================
// GUPSHUP WEBHOOK (v3 passthrough, Meta-format)
// ===================================================================
app.post('/gupshup/webhook', async (req, res) => {
  try {
    const body = req.body;
    res.status(200).send('EVENT_RECEIVED');

    if (body?.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages') {
            const value = change.value;

            // автопривязка phone_number_id к gupshup_app_id (если придёт)
            const pnid = value?.metadata?.phone_number_id;
            if (pnid && body?.gs_app_id) {
              const acc = await get(
                `SELECT id FROM accounts
                 WHERE waba_provider='gupshup' AND gupshup_app_id=? AND (waba_phone_number_id IS NULL OR waba_phone_number_id='')`,
                [String(body.gs_app_id)]
              );
              if (acc?.id) await run(`UPDATE accounts SET waba_phone_number_id=? WHERE id=?`, [String(pnid), acc.id]);
            }

            for (const message of value.messages || []) {
              await handleWABAIncoming(message, value.metadata).catch(err => console.error('[GUP] handle msg err', err));
            }
            for (const status of value.statuses || []) {
              await handleWABAStatus(status).catch(err => console.error('[GUP] handle status err', err));
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[GUP][WEBHOOK] err:', e);
    try { res.status(200).send('ERROR'); } catch(_) {}
  }
});

// --- WABA: download media to local uploads so chat.html can render it (like WA) ---
function mimeToExt(mime){
  const m = String(mime||'').toLowerCase();
  if (m.includes('image/jpeg')) return '.jpg';
  if (m.includes('image/png'))  return '.png';
  if (m.includes('image/webp')) return '.webp';
  if (m.includes('image/gif'))  return '.gif';
  if (m.includes('video/mp4'))  return '.mp4';
  if (m.includes('video/quicktime')) return '.mov';
  if (m.includes('audio/ogg') || m.includes('application/ogg')) return '.ogg';
  if (m.includes('audio/mpeg')) return '.mp3';
  if (m.includes('audio/mp4'))  return '.m4a';
  if (m.includes('application/pdf')) return '.pdf';
  if (m.includes('application/vnd.ms-excel')) return '.xls';
  if (m.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) return '.xlsx';
  if (m.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) return '.docx';
  if (m.includes('application/msword')) return '.doc';
  if (m.includes('application/vnd.openxmlformats-officedocument.presentationml.presentation')) return '.pptx';
  if (m.includes('text/plain')) return '.txt';
  return '';
}

async function wabaDownloadToUploads(wabaClient, mediaId, { forceExt='' } = {}){
  const dl = await wabaClient.downloadMedia(mediaId);
  const ext = String(forceExt||'') || mimeToExt(dl?.mime_type) || '.bin';
  const file = `uploads/waba_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
  const abs = path.join(__dirname, file);
  await fsp.writeFile(abs, dl.buffer);
  return { rel: file, abs, mime: String(dl?.mime_type||''), size: Number(dl?.file_size||0) };
}

async function handleWABAIncoming(message, metadata) {
  try {
    const phoneNumberId = metadata.phone_number_id;
    const from = message.from;
    const messageId = message.id;
    const timestamp = parseInt(message.timestamp) * 1000;

    // если Meta прислала объект-ошибку вместо нормального сообщения — не трогаем
    if (message?.errors?.length) {
      console.warn('[WABA] Incoming has errors -> skip', message.errors);
      return;
    }
    
    const account = await get(
      `SELECT id, tenant_id, waba_access_token FROM accounts 
       WHERE waba_phone_number_id = ? AND waba_enabled = 1`,
      [phoneNumberId]
    );
    
    if (!account) {
      console.warn(`[WABA] Account not found: ${phoneNumberId}`);
      return;
    }
    
    const accId = account.id;
    const tenantId = account.tenant_id;
    const jid = `${from}@s.whatsapp.net`;
    
    let messageText = '';
    let mediaKind = null;
    let mediaFile = null;
    let inboundKind = 'text';
    let suppressAI = false; // например, если распознали PDF-чек

    // reactions (не сохраняем как чат-сообщение, а обновляем реакции)
    if (message.type === 'reaction') {
      const ref = String(message?.reaction?.message_id || '').trim();
      const emoji = String(message?.reaction?.emoji || '').trim();
      if (!ref) return;

      if (emoji) {
        await upsertReactionAdd(accId, ref, emoji);
      } else {
        // сняли реакцию — простая стратегия: очистить реакции (лучше, чем оставлять мусор)
        await run(`DELETE FROM msg_reactions WHERE acc_id=? AND msg_ref=?`, [accId, ref]);
      }

      try {
        io.to(`tenant_${tenantId}`).emit('reaction:update', { acc_id: accId, msg_ref: ref });
      } catch(_) {}
      return;
    }

    if (message.type === 'text') {
      messageText = message.text?.body || '';
    } else if (message.type === 'image') {
      mediaKind = 'image';
      mediaFile = message.image?.id || null;
      messageText = message.image?.caption || '';
    } else if (message.type === 'video') {
      mediaKind = 'video';
      mediaFile = message.video?.id || null;
      messageText = message.video?.caption || '';
    } else if (message.type === 'audio') {
      mediaKind = 'audio';
      inboundKind = (message.audio && message.audio.voice === false) ? 'audio' : 'voice';
      mediaFile = message.audio?.id || null;
    } else if (message.type === 'document') {
      mediaKind = 'document';
      mediaFile = message.document?.id || null;
      messageText = message.document?.caption || '';
    } else if (message.type === 'sticker') {
      mediaKind = 'sticker';
      mediaFile = message.sticker?.id || null;
    } else {
      console.log(`[WABA] Unsupported: ${message.type}`);
      return;
    }

    // Отметим как прочитанное
    try {
      const wabaClient = new WABAClient(phoneNumberId, account.waba_access_token);
      await wabaClient.markAsRead(messageId);
    } catch (e) {
      console.warn('[WABA] Mark read failed:', e.message);
    }

    // медиа: скачиваем на диск, чтобы UI мог показать (и чтобы работали PDF/ASR)
    let downloaded = null;
    let fileNameHint = '';
    if (mediaKind && mediaFile) {
      const wabaClient = new WABAClient(phoneNumberId, account.waba_access_token);
      if (mediaKind === 'document') {
        fileNameHint = String(message.document?.filename || '').trim();
      }
      downloaded = await wabaDownloadToUploads(wabaClient, mediaFile);
      mediaFile = downloaded?.rel || '';
      // pdf как отдельный kind, чтобы UI и чек-логика корректно работали
      if (mediaKind === 'document') {
        const isPdf = (downloaded?.mime === 'application/pdf') || /\.pdf$/i.test(fileNameHint) || /\.pdf$/i.test(mediaFile);
        if (isPdf) mediaKind = 'pdf';
      }
    }

    // ASR для голосовых: превращаем [audio] → реальный текст
    if (inboundKind === 'voice' && downloaded?.abs) {
      const openaiKey = (await getSetting('openai_key', tenantId) || '').trim();
      if (openaiKey) {
        const tr = await transcribeWithFallback(downloaded.abs, openaiKey);
        const t = String(tr||'').trim();
        if (t) messageText = t;
      }
      // превью m4a для браузера (если ffmpeg есть)
      try {
        const prevAbs = await safeMakePreviewM4A(downloaded.abs);
        if (prevAbs && prevAbs !== downloaded.abs) {
          const prevRel = path.relative(__dirname, prevAbs).replace(/\\/g,'/');
          if (prevRel.startsWith('uploads/')) mediaFile = prevRel;
        }
      } catch(_) {}
    }

    // PDF: "чек" или "прочитать PDF" — как в других каналах
    if (mediaKind === 'pdf' && downloaded?.abs) {
      const openaiKey = (await getSetting('openai_key', tenantId) || '').trim();
      const receiptOcrEnabled = (await getSetting('receipt_ocr_enabled', tenantId)) === '1';
      try {
        const pdfText = await extractPdfText(downloaded.abs, openaiKey);
        if (receiptOcrEnabled) {
          let parsedSum = parseReceiptAmount(pdfText);
          if (!parsedSum && openaiKey) parsedSum = await tryLLMAmount(openaiKey, pdfText);

          if (parsedSum) {
            await confirmReceipt(accId, jid, mediaFile, pdfText, parsedSum);
            messageText = `[Чек PDF]\nАвтоматически распознано: ${parsedSum.amount.toFixed(2)}${parsedSum.currency ? (' ' + parsedSum.currency) : ''}`;
            suppressAI = true; // ✅ это чек, AI-ответ не нужен
          } else {
            const safeText = (pdfText || '').trim().slice(0, 4000);
            const title = (fileNameHint || '').trim();
            messageText = (title ? `[PDF] ${title}\n\n` : '[PDF]\n\n') + (safeText || '[Текст PDF распознать не удалось]');
          }
        } else {
          const safeText = (pdfText || '').trim().slice(0, 4000);
          const title = (fileNameHint || '').trim();
          messageText = (title ? `[PDF] ${title}\n\n` : '[PDF]\n\n') + (safeText || '[Текст PDF распознать не удалось]');
        }
      } catch(e) {
        console.warn('[WABA][PDF] extract fail:', e?.message || e);
      }
    }
    
    // ✅ чтобы ИИ реагировал на медиа (если caption/ASR пустой)
    let userText = (messageText || '').trim();
    if (!userText && mediaKind) {
      const ph = { image:'🖼 Фото', video:'🎬 Видео', audio:'🎤 Голосовое', document:'📄 Документ', pdf:'📄 PDF', sticker:'🧩 Стикер' };
      userText = ph[mediaKind] || `[${mediaKind}]`;
    }
    messageText = userText;

    const existingMsg = await get(
      `SELECT id FROM chats WHERE wa_id = ? AND acc_id = ?`,
      [messageId, accId]
    );
    
    if (existingMsg) {
      console.log(`[WABA] Duplicate: ${messageId}`);
      return;
    }
    
    // Сохраняем в таблицу chats (как Baileys)
    const ts = Math.floor(timestamp / 1000);
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const extId = crypto.randomUUID();

    await run(
      `INSERT INTO chats(tenant_id, jid, date, ts, message, type, acc_id, media_file, media_kind, crm_ext_id, wa_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, jid, date, ts, messageText || '', 'in', accId, 
        mediaFile || '', mediaKind || '', extId, messageId
      ]
    );
    
    console.log(`✅ [WABA] Message saved: ${messageId}`);

    await evaluateAndUpdateStage(accId, jid);

    // ЛИДЫ: для WABA тоже пушим в CRM (и помечаем повторный лид, если уже есть crm_id)
    try {
      const p = await getProfile(accId, jid);
      const phoneResolved = await resolvePhoneForAccJid(accId, jid);
      await pushLeadToCRM({
        tenant_id: tenantId,
        acc_id: accId,
        jid,
        phone: phoneResolved || '',
        last_message: messageText || '',
        wa_display_name: p?.name || ''
      });
    } catch(e){
      console.warn('[WABA][CRM] lead push fail:', e?.message || e);
    }

    await pushMessageToCRM({
      tenant_id: tenantId,
      acc_id: accId,
      jid,
      direction: 'in',
      text: messageText || '',
      media_file: mediaFile || '',
      media_kind: mediaKind || '',
      external_id: extId
    });

    // ⭐ НОВОЕ: Эмитим в Socket.io для realtime обновления
    try {
      io.to(`tenant_${tenantId}`).emit('newchat', {
        acc_id: accId,
        jid: jid,
        phone: from,
        type: 'in',
        ts,
        text: messageText || '',
        media_file: mediaFile || '',
        media_kind: mediaKind || '',
        date
      });
      console.log(`[WABA] Emitted to tenant_${tenantId}`);
    } catch (e) {
      console.error('[WABA] Emit error:', e.message);
    }
    
    // --- [MEDIA TRIGGERS] для WABA: отправляем медиа и выключаем AI ---
    if (!suppressAI) {
      try {
        const triggers = await loadMediaTriggers(tenantId);
        if (triggers.length) {
          const hit = triggers.find(tr => tr.media_file && mediaTriggerMatches(tr, (messageText || '')));
          if (hit) {
            const mk = (hit.media_kind || inferKindFromPath(hit.media_file) || 'document');

            // 1) медиа
            await sendViaWABA(accId, jid, hit.caption || '', hit.media_file, mk);

            // 2) доп. текст (отдельным сообщением)
            if (hit.also_reply_text && hit.also_reply_text.trim()) {
              await sleep(200);
              await sendViaWABA(accId, jid, hit.also_reply_text.trim(), '', '');
            }

            suppressAI = true; // ✅ триггер сработал → ИИ не запускаем
          }
        }
      } catch (e) {
        console.warn('[WABA][MEDIA TRIGGERS] error:', e?.message || e);
      }
    }

    // --- модерация/эскалации как в WA ---
    try {
      const lists = await getPhraseLists(tenantId);
      const { blacklist, badwords } = lists;

      const txt0 = String(messageText || '').trim();

      if (includesPhrase(txt0, blacklist)) {
        await escalate(accId, jid, 'blacklist_trigger', txt0);
      }

      if ((await getSetting('moderation_enabled', tenantId)) === '1' && includesPhrase(txt0, badwords)) {
        await escalate(accId, jid, 'moderation_badword', txt0);
        return; // AI не отвечаем
      }

      if (includesPhrase(txt0, ['оператор','менеджер','человек','позвоните','свяжитесь','дозвон'])) {
        await escalate(accId, jid, 'human_needed', txt0);
        return; // AI не отвечаем
      }
    } catch(_) {}

    // ⭐ ЗАПУСК ИИ АВТООТВЕТЧИКА (как в Baileys)
    try {
      // 1. Проверяем включён ли ИИ для аккаунта
      const accSettings = await get(
        `SELECT ai_enabled FROM accounts WHERE id = ?`,
        [accId]
      );
      
      if (!accSettings || Number(accSettings.ai_enabled) !== 1) {
        console.log(`[WABA] AI disabled for account ${accId}`);
        return;
      }
      
      // 2. Проверяем не заблокирован ли контакт
      if (await isBlocked(accId, jid)) {
        console.log(`[WABA] Contact ${jid} is blocked`);
        return;
      }
      
      // 3. Проверяем white/black lists (если есть)
      const txt = messageText || '';
      // const white = []; // можно загрузить из БД если есть
      // const forceReply = includesPhrase(txt, white);
      const forceReply = !!(txt && txt.trim().length > 0);

      // если это чек — AI не запускаем
      if (suppressAI) {
        console.log('[WABA] suppressAI=true, skip AI reply');
        return;
      }

      // важно для TTS smart-mode: если вход был голосовым — помечаем
      try {
        const k = _rk(accId, jid);
        replyInputKinds.set(k, inboundKind);
      } catch(_) {}
      
      // 4. Запускаем ИИ ответчик (та же функция что для Baileys!)
      console.log(`[WABA] Triggering AI for ${jid}...`);
      if (!suppressAI) {
        await scheduleAIReply(accId, jid, forceReply);
      } else {
        console.log('[WABA] suppressAI=true → skip scheduleAIReply');
      }
      
    } catch (e) {
      console.error('[WABA] AI trigger error:', e.message);
    }
  } catch (error) {
    console.error('[WABA] Handle message error:', error);
  }
}

async function handleWABAStatus(status) {
  try {
    const messageId = status.id;
    const statusValue = status.status;
    
    console.log(`[WABA] Status: ${messageId} -> ${statusValue}`);
    
    await run(
      `UPDATE chats SET status = ? WHERE wa_id = ?`,
      [statusValue, messageId]
    );
    
  } catch (error) {
    console.error('[WABA] Status error:', error);
  }
}

// API: Конфигурация WABA
// ===================================================================
app.post('/api/accounts/:id/waba/config', authGuard, async (req, res) => {
  try {
    const accId = parseInt(req.params.id);

    const b = req.body || {};

    const phone_number_id =
      String(b.phone_number_id || b.waba_phone_id || b.phone_id || '').trim();

    const access_token =
      String(b.access_token || b.waba_access_token || b.waba_token || b.token || '').trim();

    const enabled =
      (b.enabled === true || b.enabled === 1 || b.enabled === '1' || b.enabled === 'true');
    
    if (!await ensureOwnAccountOrHistory(req, accId)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    
    console.log(`[WABA] Configuring account ${accId}`, { phone_number_id });
    
    // ⭐ ПОЛУЧАЕМ НАСТОЯЩИЙ НОМЕР ТЕЛЕФОНА ИЗ META
    let phoneLabel = 'WABA Account';
    let displayPhone = '';
    
    if (phone_number_id && access_token && enabled) {
      try {
        console.log(`[WABA] Fetching phone info from Meta...`);
        const response = await axios.get(
          `https://graph.facebook.com/v18.0/${phone_number_id}?fields=display_phone_number,verified_name`,
          {
            headers: { 'Authorization': `Bearer ${access_token}` },
            timeout: 5000
          }
        );
        
        displayPhone = response.data.display_phone_number || '';
        const verifiedName = response.data.verified_name || '';
        
        // Используем имя бизнеса если есть, иначе номер
        phoneLabel = verifiedName || displayPhone || 'WABA Account';
        
        console.log(`[WABA] Got from Meta:`, {
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          label: phoneLabel
        });
      } catch (e) {
        console.error('[WABA] Could not fetch phone info from Meta:', e.message);
        // Используем дефолтное название если не получилось
        phoneLabel = 'WABA Account';
      }
    }

    await run(
      `UPDATE accounts SET 
        waba_enabled = ?,
        waba_phone_number_id = ?,
        waba_access_token = ?,
        status = ?,
        label = ?,
        phone = ?,
        me_jid = ?
      WHERE id = ?`,
      [
        enabled ? 1 : 0,
        phone_number_id || null,
        access_token || null,
        enabled ? 'online' : 'qr',
        phoneLabel,
        displayPhone || phone_number_id,
        (displayPhone ? (displayPhone.replace(/[^\d]/g,'') + '@s.whatsapp.net') : null),
        accId
      ]
    );
        
    console.log(`✅ [WABA] Account ${accId} configured:`, phoneLabel);
    
    return res.json({ ok: true });
  } catch (error) {
    console.error('[WABA] Config error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ===================================================================
// WABA AUTO (Gupshup Embedded Signup)
// ===================================================================
app.post('/api/accounts/:id/waba/gupshup/start', authGuard, async (req, res) => {
  try {
    const accId = Number(req.params.id);
    if (!accId) return res.status(400).json({ ok:false, error:'bad acc id' });
    if (!await ensureOwnAccountOrHistory(req, accId)) return res.status(403).json({ ok:false, error:'forbidden' });

    const pub = process.env.PUBLIC_BASE_URL;
    if (!pub) return res.status(500).json({ ok:false, error:'PUBLIC_BASE_URL is not set' });

    const appName = `nedzat_acc_${accId}_${Date.now()}`;
    const appId = await gupCreateApp(appName);

    const appToken = await gupGetAppToken(appId);

    const webhookUrl = `${pub.replace(/\/+$/,'')}/gupshup/webhook`;
    try { await gupSubscribeV3(appId, webhookUrl); }
    catch(e){ console.warn('[GUP] subscribe failed:', e?.response?.data || e?.message || e); }

    const link = await gupGetEmbedLink(appId);

    await run(
      `UPDATE accounts
       SET waba_enabled=1, waba_provider='gupshup',
           gupshup_app_id=?, gupshup_app_token=?, gupshup_status='connecting'
       WHERE id=?`,
      [String(appId), String(appToken), accId]
    );

    return res.json({ ok:true, url: link, appId });
  } catch (e) {
    console.error('[GUP][START] error:', e?.response?.data || e);
    return res.status(500).json({ ok:false, error: String(e?.response?.data?.message || e?.message || e) });
  }
});

// 1) Слушаем порт СРАЗУ (чтобы не было 502)
const PORT = process.env.PORT ? Number(process.env.PORT) : 3099;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// 2) Инициализация в фоне (и с защитой)
(async () => {
  try {
    await initSaaS();
    await initDB();

    const ids = (await all(`SELECT id FROM accounts WHERE status='online' ORDER BY id`)).map(r => r.id);
    for (const id of ids) {
      try { await startAccount(id); }
      catch (e) { console.error('start err', id, e?.message || e); }
    }

    BOOT.ready = true;
    console.log('✅ BOOT READY');
  } catch (e) {
    BOOT.error = e?.stack || e?.message || String(e);
    console.error('❌ BOOT FAILED:', BOOT.error);
    // НЕ выходим — иначе снова будут 502 при рестартах
  }
})();