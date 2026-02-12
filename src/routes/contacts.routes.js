const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard } = require('../middleware/auth');

// Helper functions (would normally be in a service, but keeping implementation simple)
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

function normalizeDirectJid(jid) {
    if (!jid) return '';
    jid = String(jid).trim();

    // If already normalized
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
        return jid;
    }

    // Extract digits and create WhatsApp JID
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

function normalizeMeJidHelper(jid) {
    if (!jid) return '';
    jid = String(jid).trim();

    // Remove @lid suffix  
    if (jid.endsWith('@lid')) {
        return jid.replace(/@lid$/i, '@s.whatsapp.net');
    }

    return jid;
}

function jidToPhone(jid) {
    if (!jid) return '';
    const match = String(jid).match(/^(\\d+)@/);
    return match ? match[1] : '';
}

/**
 * @route GET /api/contacts
 * @desc Get all contacts/profiles for tenant, with filtering and search
 */
router.get('/', authGuard, async (req, res) => {
    try {
        const accId = req.query.acc_id ? Number(req.query.acc_id) : null;
        const q = String(req.query.q || '').trim().toLowerCase();
        const stage = String(req.query.stage || '').trim();

        let limit = parseInt(String(req.query.limit || '5000'), 10);
        if (!Number.isFinite(limit)) limit = 5000;
        limit = Math.max(1, Math.min(limit, 100000));

        const tenantId = req.user.tenant_id;

        let sql = '';
        const params = [];

        if (accId) {
            if (!await ensureOwnAccountOrHistory(req, accId)) {
                return res.status(403).json({ ok: false, error: 'forbidden' });
            }

            sql = `SELECT p.*, lm.phone_number AS lid_phone
                   FROM profiles p
                   LEFT JOIN lid_mapping lm
                     ON lm.lid=p.jid AND lm.is_verified=1 AND (lm.acc_id=? OR lm.acc_id=0)
                   WHERE p.tenant_id=? AND (p.acc_id=? OR p.acc_id=0)`;
            params.push(accId, tenantId, accId);

            // Don't show the account's own number
            try {
                const acc = await db.get(
                    `SELECT kind, me_jid FROM accounts WHERE id=? AND tenant_id=?`,
                    [accId, tenantId]
                );

                const kind = String(acc?.kind || '');
                const meRaw = String(acc?.me_jid || '').trim();
                const meNorm = meRaw ? normalizeMeJidHelper(meRaw) : '';

                if (kind === 'wa') {
                    if (meNorm) {
                        sql += ` AND p.jid <> ?`;
                        params.push(meNorm);
                    }
                    if (meRaw && meRaw !== meNorm) {
                        sql += ` AND p.jid <> ?`;
                        params.push(meRaw);
                    }
                }
            } catch (_) { }

        } else {
            sql = `SELECT p.*, lm.phone_number AS lid_phone
                   FROM profiles p
                   LEFT JOIN lid_mapping lm
                     ON lm.acc_id=p.acc_id AND lm.lid=p.jid AND lm.is_verified=1
                   WHERE p.tenant_id=?`;
            params.push(tenantId);
        }

        // Filter by stage
        if (stage) {
            sql += ` AND p.stage=?`;
            params.push(stage);
        }

        // Search query
        if (q) {
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

        // Ordering
        const order = String(req.query.order || '').trim().toLowerCase();
        if (order === 'recent') {
            sql += ` ORDER BY COALESCE(p.slots_updated_at,0) DESC, p.acc_id, p.jid LIMIT ?`;
        } else {
            sql += ` ORDER BY p.acc_id, p.jid LIMIT ?`;
        }

        params.push(limit);

        const rows = await db.all(sql, params);

        // Dedup contacts by normalized jid (removes @lid duplicates in UI)
        let out = rows;

        if (accId) {
            try {
                const acc = await db.get(
                    `SELECT kind FROM accounts WHERE id=? AND tenant_id=?`,
                    [accId, tenantId]
                );
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
            } catch (_) { }
        }

        // Add computed phone field for frontend
        const enriched = (out || []).map(r => {
            const jid = String(r.jid || '').trim();
            let phone = '';

            if (jid.startsWith('tg:')) {
                phone = jid.slice(3);
            } else if (jid.startsWith('ig:')) {
                phone = ''; // Instagram has no phone
            } else {
                phone = jidToPhone(jid) || '';
                if (!phone && jid.endsWith('@lid')) {
                    phone = String(r.lid_phone || '').replace(/\\D+/g, '');
                }
            }

            const o = { ...r, phone };
            delete o.lid_phone;
            return o;
        });

        res.json({
            ok: true,
            contacts: enriched
        });
    } catch (err) {
        console.error('[CONTACTS] GET error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/contacts/:acc_id/:jid
 * @desc Update contact/profile information
 */
router.put('/:acc_id/:jid', authGuard, async (req, res) => {
    try {
        const { acc_id, jid } = req.params;
        const { name, city, budget, interest, notes, lang, last_intent, summary, stage } = req.body || {};

        if (!acc_id || !jid) {
            return res.status(400).json({ ok: false, error: 'acc_id & jid required' });
        }

        const accIdNum = Number(acc_id);

        // Verify ownership
        if (!await ensureOwnAccountOrHistory(req, accIdNum)) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        // Normalize JID based on account kind
        const accKind = await getAccKind(accIdNum);
        let jidNorm = String(jid || '').trim();

        if (accKind === 'tg') {
            jidNorm = normalizeTgJid(jidNorm);
        } else {
            jidNorm = normalizeDirectJid(jidNorm);
        }

        if (!jidNorm) {
            return res.status(400).json({ ok: false, error: 'bad jid' });
        }

        const tenantId = req.user.tenant_id;

        // Get tenant from account
        const account = await db.get(
            `SELECT tenant_id FROM accounts WHERE id=?`,
            [accIdNum]
        );

        if (!account || account.tenant_id !== tenantId) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        // Create or update profile
        const existing = await db.get(
            `SELECT jid FROM profiles WHERE tenant_id=? AND acc_id=? AND jid=?`,
            [tenantId, accIdNum, jidNorm]
        );

        if (!existing) {
            // Create new profile
            await db.run(
                `INSERT INTO profiles(tenant_id, acc_id, jid, name, city, budget, interest, notes, lang, last_intent, summary, stage, slots_updated_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [tenantId, accIdNum, jidNorm, name || '', city || '', budget || '', interest || '', notes || '', lang || '', last_intent || '', summary || '', stage || '', Date.now()]
            );
        } else {
            // Update existing profile
            const updates = [];
            const params = [];

            if (name !== undefined) { updates.push('name=?'); params.push(name); }
            if (city !== undefined) { updates.push('city=?'); params.push(city); }
            if (budget !== undefined) { updates.push('budget=?'); params.push(budget); }
            if (interest !== undefined) { updates.push('interest=?'); params.push(interest); }
            if (notes !== undefined) { updates.push('notes=?'); params.push(notes); }
            if (lang !== undefined) { updates.push('lang=?'); params.push(lang); }
            if (last_intent !== undefined) { updates.push('last_intent=?'); params.push(last_intent); }
            if (summary !== undefined) { updates.push('summary=?'); params.push(summary); }
            if (stage !== undefined) { updates.push('stage=?'); params.push(stage); }

            updates.push('slots_updated_at=?');
            params.push(Date.now());

            params.push(tenantId, accIdNum, jidNorm);

            await db.run(
                `UPDATE profiles SET ${updates.join(', ')} WHERE tenant_id=? AND acc_id=? AND jid=?`,
                params
            );
        }

        res.json({ ok: true, message: 'Contact updated successfully' });
    } catch (err) {
        console.error('[CONTACTS] PUT error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/contacts/:acc_id/:jid
 * @desc Delete a contact/profile and all associated data
 */
router.delete('/:acc_id/:jid', authGuard, async (req, res) => {
    let txStarted = false;
    try {
        const { acc_id, jid } = req.params;

        if (!acc_id || !jid) {
            return res.status(400).json({ ok: false, error: 'acc_id & jid required' });
        }

        const accIdNum = Number(acc_id);
        if (!accIdNum) {
            return res.status(400).json({ ok: false, error: 'bad acc_id' });
        }

        if (!await ensureOwnAccountOrHistory(req, accIdNum)) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

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

        if (!jidCanon) {
            return res.status(400).json({ ok: false, error: 'bad jid' });
        }

        // Don't allow deleting own number
        try {
            const acc = await db.get(
                `SELECT kind, me_jid FROM accounts WHERE id=? AND tenant_id=?`,
                [accIdNum, tenantId]
            );
            const k = String(acc?.kind || '').toLowerCase();
            const meRaw = String(acc?.me_jid || '').trim();
            const meNorm = meRaw ? normalizeMeJidHelper(meRaw) : '';
            if (k === 'wa' && meNorm && (jidCanon === meNorm)) {
                return res.status(400).json({ ok: false, error: 'cannot delete own number' });
            }
        } catch (_) { }

        // Collect JID variants for WhatsApp (@s.whatsapp.net <-> @lid)
        const jids = [];
        const push = (x) => { if (x && !jids.includes(x)) jids.push(x); };

        push(jidCanon);
        if (jidCanon.endsWith('@s.whatsapp.net')) {
            push(jidCanon.replace(/@s\\.whatsapp\\.net$/i, '@lid'));
        }
        if (jidCanon.endsWith('@lid')) {
            push(jidCanon.replace(/@lid$/i, '@s.whatsapp.net'));
        }

        // Open a short window where the trigger allows DELETE
        const nowSec = Math.floor(Date.now() / 1000);
        const until = nowSec + 60;

        await db.run('BEGIN');
        txStarted = true;

        for (const j of jids) {
            await db.run(
                `INSERT OR REPLACE INTO delete_guard(tenant_id, acc_id, jid, until_ts) VALUES(?,?,?,?)`,
                [tenantId, accIdNum, j, until]
            );
        }

        const qIn = '(' + jids.map(() => '?').join(',') + ')';
        const pAcc = [tenantId, accIdNum, ...jids];
        const pNoAcc = [tenantId, ...jids];

        // Delete profile
        await db.run(`DELETE FROM profiles WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

        // Delete chat history
        await db.run(`DELETE FROM chats WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

        // Delete related data
        await db.run(`DELETE FROM blocks WHERE tenant_id=? AND jid IN ${qIn}`, pNoAcc);
        await db.run(`DELETE FROM followups WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
        await db.run(`DELETE FROM firstmsg_state WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
        await db.run(`DELETE FROM firstmsg_jobs WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
        await db.run(`DELETE FROM escalations WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);
        await db.run(`DELETE FROM receipts WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

        // Delete Instagram data if applicable
        if (jids.some(j => String(j).startsWith('ig:'))) {
            const threadIds = jids
                .filter(j => String(j).startsWith('ig:'))
                .map(j => String(j).slice(3))
                .filter(Boolean);

            if (threadIds.length) {
                const qT = '(' + threadIds.map(() => '?').join(',') + ')';
                await db.run(`DELETE FROM ig_chat_state WHERE tenant_id=? AND thread_id IN ${qT}`, [tenantId, ...threadIds]);
                await db.run(`DELETE FROM ig_chats WHERE tenant_id=? AND thread_id IN ${qT}`, [tenantId, ...threadIds]);
            }
        }

        // Cleanup guard
        await db.run(`DELETE FROM delete_guard WHERE tenant_id=? AND acc_id=? AND jid IN ${qIn}`, pAcc);

        await db.run('COMMIT');
        txStarted = false;

        res.json({ ok: true, message: 'Contact deleted successfully' });
    } catch (err) {
        if (txStarted) {
            try {
                await db.run('ROLLBACK');
            } catch (_) { }
        }
        console.error('[CONTACTS] DELETE error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route GET /api/contacts/:acc_id/:jid
 * @desc Get detailed information for a specific contact
 */
router.get('/:acc_id/:jid', authGuard, async (req, res) => {
    try {
        const { acc_id, jid } = req.params;

        if (!acc_id || !jid) {
            return res.status(400).json({ ok: false, error: 'acc_id & jid required' });
        }

        const accIdNum = Number(acc_id);

        if (!await ensureOwnAccountOrHistory(req, accIdNum)) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }

        const tenantId = req.user.tenant_id;
        const accKind = await getAccKind(accIdNum);

        let jidNorm = String(jid || '').trim();
        if (accKind === 'tg') {
            jidNorm = normalizeTgJid(jidNorm);
        } else if (accKind === 'ig') {
            jidNorm = jidNorm.startsWith('ig:') ? jidNorm : ('ig:' + jidNorm);
        } else {
            jidNorm = normalizeDirectJid(jidNorm);
        }

        if (!jidNorm) {
            return res.status(400).json({ ok: false, error: 'bad jid' });
        }

        const profile = await db.get(
            `SELECT * FROM profiles WHERE tenant_id=? AND acc_id=? AND jid=?`,
            [tenantId, accIdNum, jidNorm]
        );

        if (!profile) {
            return res.status(404).json({ ok: false, error: 'contact not found' });
        }

        // Add phone number
        let phone = '';
        if (jidNorm.startsWith('tg:')) {
            phone = jidNorm.slice(3);
        } else if (jidNorm.startsWith('ig:')) {
            phone = '';
        } else {
            phone = jidToPhone(jidNorm) || '';
        }

        res.json({
            ok: true,
            contact: {
                ...profile,
                phone
            }
        });
    } catch (err) {
        console.error('[CONTACTS] GET/:id error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
