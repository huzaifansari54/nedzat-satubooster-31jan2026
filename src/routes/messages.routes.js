const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        const safe = name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 50);
        cb(null, `${Date.now()}_${safe}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (req, file, cb) => {
        const allowed = /\\.(jpg|jpeg|png|gif|webp|mp4|mp3|ogg|webm|pdf|doc|docx|xls|xlsx|zip|txt)$/i;
        if (allowed.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'));
        }
    }
});

// Helper functions
async function ensureOwnAccountOrHistory(req, accId) {
    const account = await db.get(
        `SELECT id FROM accounts WHERE id=? AND tenant_id=?`,
        [accId, req.user.tenant_id]
    );
    return !!account;
}

async function getAccKind(accId) {
    const acc = await db.get(`SELECT kind FROM accounts WHERE id=?`, [accId]);
    return String(acc?.kind || 'wa').toLowerCase();
}

async function getAccTenant(accId) {
    const acc = await db.get(`SELECT tenant_id FROM accounts WHERE id=?`, [accId]);
    return acc?.tenant_id || 0;
}

function normalizeDirectJid(jid) {
    if (!jid) return '';
    jid = String(jid).trim();
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return jid;
    const digits = jid.replace(/\\D/g, '');
    if (!digits) return '';
    return digits + '@s.whatsapp.net';
}

function normalizeTgJid(jid) {
    if (!jid) return '';
    jid = String(jid).trim();
    if (jid.startsWith('tg:')) return jid;
    return 'tg:' + jid;
}

function toPublicMediaPath(file) {
    if (!file) return '';
    file = String(file).replace(/^\\/ / g, '');
    return '/' + file;
}

async function attachReactionsToRows(tenantId, accId, jid, rows) {
    // Stub implementation - would load reactions from msg_reactions table
    // For now, just add empty reactions array to each row
    for (const r of rows) {
        r.reactions = [];
    }
}

/**
 * @route GET /api/messages/history
 * @desc Get message history for a specific contact
 */
router.get('/history', authGuard, async (req, res) => {
    try {
        const acc_id = Number(req.query.acc_id);
        const jidRaw = String(req.query.jid || '').trim();
        const limit = Math.min(400, Math.max(20, parseInt(req.query.limit || '120', 10)));
        const before = parseInt(req.query.before || '0', 10) || 0;

        if (!acc_id || !jidRaw) {
            return res.status(400).json({ ok: false, error: 'acc_id & jid required' });
        }

        if (!await ensureOwnAccountOrHistory(req, acc_id)) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        const accKind = await getAccKind(acc_id);

        // Instagram
        if (accKind === 'ig') {
            const tenantId = await getAccTenant(acc_id);
            const threadId = jidRaw.startsWith('ig:') ? jidRaw.slice(3) : jidRaw;
            if (!threadId) {
                return res.status(400).json({ ok: false, error: 'bad ig jid' });
            }

            const params = [tenantId, threadId];
            let sql = `SELECT id, ts, direction AS type, text AS message,
                              '' AS media_file, '' AS media_kind,
                              NULL AS prompt_tokens, NULL AS completion_tokens, 
                              NULL AS total_tokens, NULL AS model, NULL AS cost_usd
                       FROM ig_chats
                       WHERE tenant_id=? AND thread_id=?`;
            if (before > 0) {
                sql += ` AND ts < ?`;
                params.push(before);
            }
            sql += ` ORDER BY ts DESC LIMIT ?`;
            params.push(limit);

            const rows = await db.all(sql, params);
            rows.reverse();
            return res.json({ ok: true, messages: rows });
        }

        // Telegram / WhatsApp
        const jidNorm = (accKind === 'tg') ? normalizeTgJid(jidRaw) : normalizeDirectJid(jidRaw);
        if (!jidNorm) {
            return res.status(400).json({ ok: false, error: 'bad jid' });
        }

        const params = [req.user.tenant_id, acc_id, jidNorm];
        let sql = `SELECT id, ts, type, message, media_file, media_kind, wa_id,
                          media_name, media_mime, media_size,
                          prompt_tokens, completion_tokens, total_tokens, model, cost_usd
                   FROM chats 
                   WHERE tenant_id=? AND acc_id=? AND jid=?`;
        if (before > 0) {
            sql += ` AND ts < ?`;
            params.push(before);
        }
        sql += ` ORDER BY ts DESC, id DESC LIMIT ?`;
        params.push(limit);

        const rows = await db.all(sql, params);
        rows.reverse();

        // Convert media paths to public URLs
        for (const r of rows) {
            if (r && r.media_file) {
                r.media_file = toPublicMediaPath(r.media_file);
            }
        }

        await attachReactionsToRows(req.user.tenant_id, acc_id, jidNorm, rows);

        res.json({ ok: true, messages: rows });
    } catch (err) {
        console.error('[MESSAGES] GET /history error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route POST /api/messages/send
 * @desc Send a message (simplified version - complex logic remains in index.js for now)
 * Note: This is a placeholder. The full implementation in index.js is 400+ lines
 * and handles WhatsApp (Baileys & WABA), Telegram, and Instagram differently.
 */
router.post('/send', authGuard, async (req, res) => {
    try {
        const { acc_id, jid, text, media_file, media_kind } = req.body || {};

        if (!acc_id || !jid) {
            return res.status(400).json({ ok: false, error: 'acc_id & jid required' });
        }

        if (!text && !media_file) {
            return res.status(400).json({ ok: false, error: 'text or media required' });
        }

        const accIdNum = Number(acc_id);
        if (!await ensureOwnAccountOrHistory(req, accIdNum)) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        // ⚠️ IMPORTANT: This is a simplified stub implementation
        // The full implementation in index.js (line 14109-14522) handles:
        // - WhatsApp via Baileys (socket-based)
        // - WhatsApp via WABA (Meta Cloud API)
        // - WhatsApp via Gupshup
        // - Telegram Bot API
        // - Instagram Messaging API
        // - Template rendering
        // - Media file conversion
        // - Deduplication
        // - CRM sync
        // - Real-time socket.io updates
        //
        // For production use, the full implementation from index.js should be 
        // extracted into a service layer and called from here.

        res.status(501).json({
            ok: false,
            error: 'send_not_implemented',
            message: 'Message sending is still handled by the legacy /api/send endpoint in index.js. ' +
                'To complete this route, extract the full send logic from index.js lines 14109-14522 ' +
                'into a message-sending service and call it from here.'
        });

    } catch (err) {
        console.error('[MESSAGES] POST /send error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route POST /api/messages/upload
 * @desc Upload a media file for use in messages
 */
router.post('/upload', authGuard, upload.single('file'), (req, res) => {
    try {
        const f = req.file;
        if (!f) {
            return res.status(400).json({ ok: false, error: 'no file' });
        }

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

    } catch (err) {
        console.error('[MESSAGES] POST /upload error:', err.message);
        res.status(400).json({ ok: false, error: err.message });
    }
});

/**
 * @route DELETE /api/messages/upload/:filename
 * @desc Delete an uploaded file
 */
router.delete('/upload/:filename', authGuard, async (req, res) => {
    try {
        const filename = req.params.filename;
        if (!filename) {
            return res.status(400).json({ ok: false, error: 'filename required' });
        }

        const rel = 'uploads/' + filename;
        const abs = path.join(__dirname, '../../', rel);

        // Security: ensure path is within uploads directory
        if (!rel.startsWith('uploads/')) {
            return res.status(400).json({ ok: false, error: 'bad path' });
        }

        await fsp.rm(abs, { force: true });
        res.json({ ok: true, message: 'File deleted successfully' });

    } catch (err) {
        console.error('[MESSAGES] DELETE /upload error:', err.message);
        res.status(400).json({ ok: false, error: err.message });
    }
});

/**
 * @route GET /api/messages/stats
 * @desc Get message statistics for tenant
 */
router.get('/stats', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const accId = req.query.acc_id ? Number(req.query.acc_id) : null;

        let params = [tenantId];
        let accFilter = '';
        if (accId) {
            if (!await ensureOwnAccountOrHistory(req, accId)) {
                return res.status(403).json({ ok: false, error: 'forbidden' });
            }
            accFilter = ' AND acc_id=?';
            params.push(accId);
        }

        const [
            totalMessages,
            inboundMessages,
            outboundMessages,
            uniqueContacts,
            mediaMessages
        ] = await Promise.all([
            db.get(`SELECT COUNT(*) as count FROM chats WHERE tenant_id=?${accFilter}`, params),
            db.get(`SELECT COUNT(*) as count FROM chats WHERE tenant_id=?${accFilter} AND type='in'`, params),
            db.get(`SELECT COUNT(*) as count FROM chats WHERE tenant_id=?${accFilter} AND type='out'`, params),
            db.get(`SELECT COUNT(DISTINCT jid) as count FROM chats WHERE tenant_id=?${accFilter}`, params),
            db.get(`SELECT COUNT(*) as count FROM chats WHERE tenant_id=?${accFilter} AND media_file IS NOT NULL AND media_file != ''`, params)
        ]);

        res.json({
            ok: true,
            stats: {
                total_messages: totalMessages?.count || 0,
                inbound_messages: inboundMessages?.count || 0,
                outbound_messages: outboundMessages?.count || 0,
                unique_contacts: uniqueContacts?.count || 0,
                media_messages: mediaMessages?.count || 0
            }
        });
    } catch (err) {
        console.error('[MESSAGES] GET /stats error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
