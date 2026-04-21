const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');
const analytics = require('../services/analytics');
const { logger } = require('../utils');

// ===================================================================
// ANALYTICS ROUTES
// ===================================================================
// Visitor tracking and analytics endpoints

/**
 * @route POST /api/analytics/track
 * @desc Track a visitor event (pageview, custom event)
 * @public No authentication required for tracking
 */
router.post('/track', async (req, res) => {
    try {
        const aid = req.cookies.aid || req.body.aid;
        const sid = req.cookies.sid || req.body.sid;
        const ip = analytics.getClientIp(req);
        const ua = req.headers['user-agent'] || '';
        const referer = req.headers.referer || req.headers.referrer || '';

        await analytics.recordVisitorEvent({
            aid,
            sid,
            ip,
            ua,
            body: req.body,
            referer
        });

        res.json({ ok: true });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] Track error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/sessions
 * @desc Get visitor sessions with filters
 * @query range - Time range (today, yesterday, 24h, 7d, 14d, 30d, 90d, last_month)
 * @query limit - Limit number of results (default: 100)
 * @query country - Filter by country code
 * @query device - Filter by device type (mobile, desktop)
 * @admin Only accessible by admins
 */
router.get('/sessions', authGuard, adminOnly, async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const limit = req.query.limit ? Number(req.query.limit) : 100;
        const country = req.query.country || '';
        const device = req.query.device || '';

        const { start, end } = analytics.rangeToTs(range);

        let query = `
            SELECT sid, aid, first_seen, last_seen, country, ref_host, 
                   ref_full, path_first, browser, device
            FROM analytics_sessions
            WHERE last_seen >= ? AND last_seen <= ?
        `;
        const params = [start, end];

        if (country) {
            query += ` AND country = ?`;
            params.push(country);
        }

        if (device) {
            query += ` AND device = ?`;
            params.push(device);
        }

        query += ` ORDER BY last_seen DESC LIMIT ?`;
        params.push(limit);

        const sessions = await db.all(query, params);

        res.json({
            ok: true,
            sessions,
            range,
            start,
            end
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] GET sessions error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/events
 * @desc Get visitor events
 * @query range - Time range (today, yesterday, 24h, 7d, 14d, 30d, 90d, last_month)
 * @query limit - Limit number of results (default: 100)
 * @query type - Filter by event type (pageview, custom)
 * @query path - Filter by path
 * @admin Only accessible by admins
 */
router.get('/events', authGuard, adminOnly, async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const limit = req.query.limit ? Number(req.query.limit) : 100;
        const type = req.query.type || '';
        const path = req.query.path || '';

        const { start, end } = analytics.rangeToTs(range);

        let query = `
            SELECT id, ts, sid, aid, type, path, ref_host, 
                   country, browser, device
            FROM analytics_events
            WHERE ts >= ? AND ts <= ?
        `;
        const params = [start, end];

        if (type) {
            query += ` AND type = ?`;
            params.push(type);
        }

        if (path) {
            query += ` AND path LIKE ?`;
            params.push(`%${path}%`);
        }

        query += ` ORDER BY ts DESC LIMIT ?`;
        params.push(limit);

        const events = await db.all(query, params);

        res.json({
            ok: true,
            events,
            range,
            start,
            end
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] GET events error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/stats
 * @desc Get aggregated analytics statistics
 * @query range - Time range (today, yesterday, 24h, 7d, 14d, 30d, 90d, last_month)
 * @admin Only accessible by admins
 */
router.get('/stats', authGuard, adminOnly, async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const { start, end } = analytics.rangeToTs(range);

        // Total sessions
        const sessionsResult = await db.get(
            `SELECT COUNT(DISTINCT sid) as total 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ?`,
            [start, end]
        );

        // Total unique visitors (by aid)
        const visitorsResult = await db.get(
            `SELECT COUNT(DISTINCT aid) as total 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ?`,
            [start, end]
        );

        // Total pageviews
        const pageviewsResult = await db.get(
            `SELECT COUNT(*) as total 
             FROM analytics_events 
             WHERE ts >= ? AND ts <= ? AND type = 'pageview'`,
            [start, end]
        );

        // Top countries
        const topCountries = await db.all(
            `SELECT country, COUNT(*) as count 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ? AND country != ''
             GROUP BY country 
             ORDER BY count DESC 
             LIMIT 10`,
            [start, end]
        );

        // Top referrers
        const topReferrers = await db.all(
            `SELECT ref_host, COUNT(*) as count 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ? AND ref_host != ''
             GROUP BY ref_host 
             ORDER BY count DESC 
             LIMIT 10`,
            [start, end]
        );

        // Device breakdown
        const deviceBreakdown = await db.all(
            `SELECT device, COUNT(*) as count 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ? AND device != ''
             GROUP BY device 
             ORDER BY count DESC`,
            [start, end]
        );

        // Browser breakdown
        const browserBreakdown = await db.all(
            `SELECT browser, COUNT(*) as count 
             FROM analytics_sessions 
             WHERE last_seen >= ? AND last_seen <= ? AND browser != ''
             GROUP BY browser 
             ORDER BY count DESC 
             LIMIT 10`,
            [start, end]
        );

        // Top pages
        const topPages = await db.all(
            `SELECT path, COUNT(*) as views 
             FROM analytics_events 
             WHERE ts >= ? AND ts <= ? AND type = 'pageview' AND path != ''
             GROUP BY path 
             ORDER BY views DESC 
             LIMIT 20`,
            [start, end]
        );

        res.json({
            ok: true,
            range,
            start,
            end,
            stats: {
                sessions: sessionsResult.total || 0,
                uniqueVisitors: visitorsResult.total || 0,
                pageviews: pageviewsResult.total || 0
            },
            topCountries,
            topReferrers,
            deviceBreakdown,
            browserBreakdown,
            topPages
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] GET stats error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/timeline
 * @desc Get timeline data (pageviews over time)
 * @query range - Time range (today, yesterday, 24h, 7d, 14d, 30d, 90d, last_month)
 * @query interval - Grouping interval (hour, day) - auto-detected if not specified
 * @admin Only accessible by admins
 */
router.get('/timeline', authGuard, adminOnly, async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const { start, end } = analytics.rangeToTs(range);

        // Auto-detect interval based on range
        let interval = req.query.interval;
        if (!interval) {
            const durationHours = (end - start) / (1000 * 3600);
            interval = durationHours <= 48 ? 'hour' : 'day';
        }

        let groupBy;
        if (interval === 'hour') {
            groupBy = `strftime('%Y-%m-%d %H:00', datetime(ts/1000, 'unixepoch'))`;
        } else {
            groupBy = `strftime('%Y-%m-%d', datetime(ts/1000, 'unixepoch'))`;
        }

        const timeline = await db.all(
            `SELECT ${groupBy} as period, COUNT(*) as pageviews
             FROM analytics_events
             WHERE ts >= ? AND ts <= ? AND type = 'pageview'
             GROUP BY period
             ORDER BY period ASC`,
            [start, end]
        );

        res.json({
            ok: true,
            range,
            interval,
            timeline
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] GET timeline error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/session/:sid
 * @desc Get detailed information about a specific session
 * @admin Only accessible by admins
 */
router.get('/session/:sid', authGuard, adminOnly, async (req, res) => {
    try {
        const { sid } = req.params;

        if (!sid) {
            return res.status(400).json({ ok: false, error: 'Session ID required' });
        }

        // Get session details
        const session = await db.get(
            `SELECT * FROM analytics_sessions WHERE sid = ?`,
            [sid]
        );

        if (!session) {
            return res.status(404).json({ ok: false, error: 'Session not found' });
        }

        // Get events for this session
        const events = await db.all(
            `SELECT * FROM analytics_events 
             WHERE sid = ? 
             ORDER BY ts ASC`,
            [sid]
        );

        res.json({
            ok: true,
            session,
            events
        });
    } catch (err) {
        logger.error({ err, sid: req.params.sid }, '[ANALYTICS] GET session/:sid error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/visitor/:aid
 * @desc Get all sessions and activity for a visitor
 * @admin Only accessible by admins
 */
router.get('/visitor/:aid', authGuard, adminOnly, async (req, res) => {
    try {
        const { aid } = req.params;

        if (!aid) {
            return res.status(400).json({ ok: false, error: 'Visitor ID required' });
        }

        // Get all sessions for this visitor
        const sessions = await db.all(
            `SELECT * FROM analytics_sessions 
             WHERE aid = ? 
             ORDER BY last_seen DESC`,
            [aid]
        );

        if (sessions.length === 0) {
            return res.status(404).json({ ok: false, error: 'Visitor not found' });
        }

        // Get total events count
        const eventsCount = await db.get(
            `SELECT COUNT(*) as total 
             FROM analytics_events 
             WHERE aid = ?`,
            [aid]
        );

        res.json({
            ok: true,
            aid,
            sessions,
            totalSessions: sessions.length,
            totalEvents: eventsCount.total || 0
        });
    } catch (err) {
        logger.error({ err, aid: req.params.aid }, '[ANALYTICS] GET visitor/:aid error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/analytics/realtime
 * @desc Get real-time analytics (last 30 minutes)
 * @admin Only accessible by admins
 */
router.get('/realtime', authGuard, adminOnly, async (req, res) => {
    try {
        const now = Date.now();
        const thirtyMinutesAgo = now - (30 * 60 * 1000);

        // Active sessions (last seen in last 30 min)
        const activeSessions = await db.all(
            `SELECT sid, aid, last_seen, country, browser, device, path_first
             FROM analytics_sessions
             WHERE last_seen >= ?
             ORDER BY last_seen DESC
             LIMIT 50`,
            [thirtyMinutesAgo]
        );

        // Recent pageviews
        const recentPageviews = await db.all(
            `SELECT ts, path, country, device
             FROM analytics_events
             WHERE ts >= ? AND type = 'pageview'
             ORDER BY ts DESC
             LIMIT 50`,
            [thirtyMinutesAgo]
        );

        // Active visitors by country
        const visitorsByCountry = await db.all(
            `SELECT country, COUNT(DISTINCT sid) as count
             FROM analytics_sessions
             WHERE last_seen >= ? AND country != ''
             GROUP BY country
             ORDER BY count DESC`,
            [thirtyMinutesAgo]
        );

        res.json({
            ok: true,
            activeSessions: activeSessions.length,
            sessions: activeSessions,
            recentPageviews,
            visitorsByCountry,
            asOf: now
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] GET realtime error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/analytics/cleanup
 * @desc Clean up old analytics data
 * @query days - Number of days to keep (default: 90)
 * @admin Only accessible by admins
 */
router.delete('/cleanup', authGuard, adminOnly, async (req, res) => {
    try {
        const days = req.query.days ? Number(req.query.days) : 90;
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

        // Delete old events
        const eventsResult = await db.run(
            `DELETE FROM analytics_events WHERE ts < ?`,
            [cutoff]
        );

        // Delete old sessions that haven't been active
        const sessionsResult = await db.run(
            `DELETE FROM analytics_sessions WHERE last_seen < ?`,
            [cutoff]
        );

        res.json({
            ok: true,
            deletedEvents: eventsResult.changes || 0,
            deletedSessions: sessionsResult.changes || 0,
            cutoffDate: new Date(cutoff).toISOString()
        });
    } catch (err) {
        logger.error({ err }, '[ANALYTICS] DELETE cleanup error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
