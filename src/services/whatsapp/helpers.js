// src/services/whatsapp/helpers.js
// -------------------------------------------------

/**
 * Normalize WhatsApp JID to plain digits (phone number)
 * Supports:
 * - "7705...@s.whatsapp.net" -> "7705..."
 * - "7705..." or "+7705 ..." -> "7705..."
 * - "accId:7705...@s.whatsapp.net" -> "7705..."
 */
function jidToPhone(jid) {
    const s0 = String(jid || '').trim();
    if (!s0) return '';

    // Remove accId prefix if present
    const s = s0.replace(/^(\d+):/, '');

    if (s.startsWith('tg:')) return '';
    if (s.endsWith('@lid')) return s.replace(/@lid$/, '').replace(/\D+/g, '');
    if (s.endsWith('@s.whatsapp.net')) return s.replace(/@s\.whatsapp\.net$/, '').replace(/\D+/g, '');
    if (s.endsWith('@g.us')) return ''; // Groups don't have a single phone
    if (s.endsWith('@broadcast')) return '';

    return s.replace(/\D+/g, '');
}

/**
 * Normalize JID for WhatsApp (ensure digits@s.whatsapp.net)
 */
function normalizeDirectJid(jid) {
    if (!jid) return '';
    const s = String(jid).trim();
    if (s.endsWith('@s.whatsapp.net') || s.endsWith('@lid')) return s;
    const digits = s.replace(/\D+/g, '');
    if (!digits) return '';
    return digits + '@s.whatsapp.net';
}

/**
 * Normalize "Me" JID (strip device ID)
 */
function normalizeMeJid(me) {
    const raw0 = String(me || '').trim();
    if (!raw0) return '';

    if (raw0.includes('@')) {
        const at = raw0.indexOf('@');
        const left = raw0.slice(0, at);      // "7747...:52"
        const dom = raw0.slice(at + 1);      // "s.whatsapp.net"
        const left2 = left.split(':')[0];    // "7747..."
        const digits = left2.replace(/\D+/g, '');
        if (digits) return `${digits}@${dom}`;
        return raw0;
    }

    return normalizeDirectJid(raw0);
}

/**
 * Check if string looks like phone digits
 */
function looksLikePhoneDigits(s) {
    const d = String(s || '').replace(/\D+/g, '');
    return d.length >= 7 && d.length <= 16;
}

module.exports = {
    jidToPhone,
    normalizeDirectJid,
    normalizeMeJid,
    looksLikePhoneDigits
};
