const crypto = require('crypto');
const { get, run, all } = require('../../database');

let UAParser = null;
try {
    UAParser = require('ua-parser-js');
} catch (e) {
    console.warn('[UA] ua-parser-js not installed, using fallback');
}

/**
 * Parse User Agent string into browser and device info.
 * @param {string} uaRaw 
 * @returns {Object} { browser, device }
 */
function parseUA(uaRaw) {
    const ua = String(uaRaw || '');
    let browser = '';
    let device = '';

    try {
        if (UAParser) {
            const p = new UAParser(ua).getResult();
            browser = [p.browser?.name, p.browser?.version].filter(Boolean).join(' ');
            device = p.device?.type || 'desktop';
            if (!device) device = 'desktop';
            return { browser: browser || '', device };
        }
    } catch (_) { }

    // Minimal static fallback
    const u = ua.toLowerCase();
    device = /mobile|android|iphone|ipad/.test(u) ? 'mobile' : 'desktop';
    if (u.includes('edg/')) browser = 'Edge';
    else if (u.includes('chrome/')) browser = 'Chrome';
    else if (u.includes('safari/') && !u.includes('chrome/')) browser = 'Safari';
    else if (u.includes('firefox/')) browser = 'Firefox';
    else browser = 'Other';
    return { browser, device };
}

/**
 * Get hostname from referrer URL.
 * @param {string} ref 
 * @returns {string}
 */
function getRefHost(ref) {
    try {
        return ref ? (new URL(ref)).host : '';
    } catch {
        return '';
    }
}

/**
 * Convert time range string to {start, end} timestamps.
 * @param {string} range 
 * @returns {Object} { start, end }
 */
function rangeToTs(range) {
    const now = new Date();
    const end = Date.now();

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    switch (range) {
        case 'today': return { start: startOfDay(now), end };
        case 'yesterday': {
            const y = new Date(now.getTime() - 24 * 3600 * 1000);
            const s = startOfDay(y);
            return { start: s, end: s + 24 * 3600 * 1000 };
        }
        case '24h': return { start: end - 24 * 3600 * 1000, end };
        case '7d': return { start: end - 7 * 24 * 3600 * 1000, end };
        case '14d': return { start: end - 14 * 24 * 3600 * 1000, end };
        case '30d': return { start: end - 30 * 24 * 3600 * 1000, end };
        case '90d': return { start: end - 90 * 24 * 3600 * 1000, end };
        case 'last_month': {
            const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
            const firstPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            return { start: firstPrev.getTime(), end: firstThis.getTime() };
        }
        default: return { start: end - 7 * 24 * 3600 * 1000, end };
    }
}

/**
 * Records a visitor event (session management and event logging).
 * @param {Object} params 
 */
async function recordVisitorEvent({
    aid,
    sid,
    ip,
    ua,
    body,
    referer = ''
}) {
    const now = Date.now();
    const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
    const ip_hash = ip ? crypto.createHash('sha256').update(ip + '|' + JWT_SECRET).digest('hex') : '';

    const { browser, device } = parseUA(ua);
    const { getCountry } = require('./geo-parser'); // late require to avoid circularity if any
    const country = getCountry({ headers: {} }, ip); // mock req with no headers if just ip is provided

    const type = String(body.type || 'pageview');
    const pathStr = String(body.path || referer || '').slice(0, 500);
    const ref = String(body.ref || '').slice(0, 1000);
    const ref_host = getRefHost(ref || referer);

    // Initial session insertion or update
    const existing = await get(`SELECT sid FROM analytics_sessions WHERE sid=?`, [sid]);
    if (!existing) {
        await run(
            `INSERT OR REPLACE INTO analytics_sessions
             (sid, aid, first_seen, last_seen, country, ref_host, ref_full, path_first, ua, browser, device, ip_hash)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [sid, aid, now, now, country, ref_host, ref, pathStr, ua, browser, device, ip_hash]
        ).catch(() => { });
    } else {
        await run(
            `UPDATE analytics_sessions SET last_seen=?, country=COALESCE(NULLIF(country,''),?), browser=COALESCE(NULLIF(browser,''),?), device=COALESCE(NULLIF(device,''),?)
             WHERE sid=?`,
            [now, country, browser, device, sid]
        ).catch(() => { });
    }

    // Event logging
    if (type === 'pageview') {
        await run(
            `INSERT INTO analytics_events(ts, sid, aid, type, path, ref_host, country, browser, device)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [now, sid, aid, type, pathStr, ref_host, country, browser, device]
        ).catch(() => { });
    }
}

module.exports = {
    parseUA,
    getRefHost,
    rangeToTs,
    recordVisitorEvent
};
