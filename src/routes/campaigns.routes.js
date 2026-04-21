const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard } = require('../middleware/auth');
const campaigns = require('../services/campaigns');
const whatsapp = require('../services/whatsapp');
const { logger } = require('../utils');

// ===================================================================
// CAMPAIGN ROUTES
// ===================================================================
// Endpoints for campaign management, execution, analytics, and scheduling

/**
 * @route GET /api/campaigns
 * @desc Get all campaigns for the authenticated user's tenant
 * @query status - Filter by status (draft, running, paused, done, error)
 * @query acc_id - Filter by account ID
 * @query limit - Limit number of results
 */
router.get('/', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const filters = {};

        if (req.query.status) {
            filters.status = req.query.status;
        }

        if (req.query.acc_id) {
            filters.accId = Number(req.query.acc_id);
        }

        if (req.query.limit) {
            filters.limit = Number(req.query.limit);
        }

        const campaignList = await campaigns.getCampaigns(tenantId, filters);

        res.json({
            ok: true,
            campaigns: campaignList
        });
    } catch (err) {
        logger.error({ err }, '[CAMPAIGNS] GET error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/campaigns
 * @desc Create a new campaign
 * @body acc_id - Account ID
 * @body title - Campaign title
 * @body text - Message text
 * @body media_file - Optional media file URL
 * @body media_kind - Optional media type (image, video, document, audio)
 * @body settings - Optional campaign settings
 */
router.post('/', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const {
            acc_id,
            title,
            text,
            media_file,
            media_kind,
            settings = {}
        } = req.body;

        // Validate required fields
        if (!acc_id || !title) {
            return res.status(400).json({
                ok: false,
                error: 'acc_id and title are required'
            });
        }

        // Verify account belongs to tenant
        const account = await db.get(
            `SELECT id FROM accounts WHERE id = ? AND tenant_id = ?`,
            [acc_id, tenantId]
        );

        if (!account) {
            return res.status(403).json({
                ok: false,
                error: 'Account not found or access denied'
            });
        }

        const campaignId = await campaigns.createCampaign({
            tenantId,
            accId: acc_id,
            title,
            text: text || '',
            mediaFile: media_file,
            mediaKind: media_kind,
            settings
        });

        res.json({
            ok: true,
            campaign_id: campaignId,
            message: 'Campaign created successfully'
        });
    } catch (err) {
        logger.error({ err }, '[CAMPAIGNS] POST error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id
 * @desc Get campaign details by ID
 */
router.get('/:id', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        const campaign = await campaigns.getCampaign(campaignId, tenantId);

        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        res.json({
            ok: true,
            campaign
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route PUT /api/campaigns/:id
 * @desc Update campaign details
 * @body title - Updated title
 * @body text - Updated message text
 * @body media_file - Updated media file URL
 * @body media_kind - Updated media type
 * @body settings - Updated settings (merged with existing)
 */
router.put('/:id', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign exists and belongs to tenant
        const existing = await campaigns.getCampaign(campaignId, tenantId);
        if (!existing) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        // Prevent updating running campaigns
        if (existing.status === campaigns.CAMPAIGN_STATUS.RUNNING) {
            return res.status(400).json({
                ok: false,
                error: 'Cannot update a running campaign. Pause it first.'
            });
        }

        const updates = {};
        const { title, text, media_file, media_kind, settings } = req.body;

        if (title !== undefined) updates.title = title;
        if (text !== undefined) updates.text = text;
        if (media_file !== undefined) updates.media_file = media_file;
        if (media_kind !== undefined) updates.media_kind = media_kind;
        if (settings !== undefined) updates.settings_json = settings;

        const success = await campaigns.updateCampaign(campaignId, tenantId, updates);

        if (!success) {
            return res.status(400).json({ ok: false, error: 'No fields to update' });
        }

        res.json({
            ok: true,
            message: 'Campaign updated successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] PUT error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/campaigns/:id
 * @desc Delete a campaign and all its targets
 */
router.delete('/:id', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        const success = await campaigns.deleteCampaign(campaignId, tenantId);

        if (!success) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        res.json({
            ok: true,
            message: 'Campaign deleted successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] DELETE error');

        if (err.message.includes('running campaign')) {
            return res.status(400).json({ ok: false, error: err.message });
        }

        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/targets
 * @desc Get all targets for a campaign
 * @query status - Filter by target status (queued, sent, failed, skipped)
 * @query limit - Limit number of results
 */
router.get('/:id/targets', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.limit) filters.limit = Number(req.query.limit);

        const targets = await campaigns.getTargets(campaignId, tenantId, filters);

        res.json({
            ok: true,
            targets
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/targets error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/campaigns/:id/targets
 * @desc Add targets to a campaign
 * @body jids - Array of WhatsApp JIDs
 */
router.post('/:id/targets', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;
        const { jids } = req.body;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        if (!Array.isArray(jids) || jids.length === 0) {
            return res.status(400).json({
                ok: false,
                error: 'jids must be a non-empty array'
            });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const addedCount = await campaigns.addTargets(campaignId, tenantId, jids);

        res.json({
            ok: true,
            added: addedCount,
            message: `${addedCount} target(s) added successfully`
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] POST/:id/targets error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/campaigns/:id/targets/:jid
 * @desc Remove a specific target from a campaign
 */
router.delete('/:id/targets/:jid', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;
        const jid = req.params.jid;

        if (!campaignId || !jid) {
            return res.status(400).json({
                ok: false,
                error: 'Campaign ID and JID are required'
            });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        await campaigns.removeTarget(campaignId, tenantId, jid);

        res.json({
            ok: true,
            message: 'Target removed successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id, jid: req.params.jid }, '[CAMPAIGNS] DELETE/:id/targets/:jid error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/counts
 * @desc Get target counts by status for a campaign
 */
router.get('/:id/counts', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const counts = await campaigns.getTargetCounts(campaignId, tenantId);

        res.json({
            ok: true,
            counts
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/counts error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/campaigns/:id/start
 * @desc Start or resume a campaign
 */
router.post('/:id/start', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        // Check if campaign has targets
        const counts = await campaigns.getTargetCounts(campaignId, tenantId);
        if (counts.total === 0) {
            return res.status(400).json({
                ok: false,
                error: 'Cannot start campaign without targets'
            });
        }

        await campaigns.updateStatus(campaignId, tenantId, campaigns.CAMPAIGN_STATUS.RUNNING);

        res.json({
            ok: true,
            message: 'Campaign started successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] POST/:id/start error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/campaigns/:id/pause
 * @desc Pause a running campaign
 */
router.post('/:id/pause', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        await campaigns.updateStatus(campaignId, tenantId, campaigns.CAMPAIGN_STATUS.PAUSED);

        res.json({
            ok: true,
            message: 'Campaign paused successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] POST/:id/pause error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/stats
 * @desc Get detailed statistics for a campaign
 */
router.get('/:id/stats', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const stats = await campaigns.getCampaignStats(campaignId, tenantId);

        res.json({
            ok: true,
            stats
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/stats error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/responses
 * @desc Get responses from campaign targets
 * @query limit - Limit number of responses (default: 100)
 */
router.get('/:id/responses', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;
        const limit = req.query.limit ? Number(req.query.limit) : 100;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const responses = await campaigns.getCampaignResponses(campaignId, tenantId, limit);

        res.json({
            ok: true,
            responses
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/responses error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/timeline
 * @desc Get hourly timeline of campaign execution
 */
router.get('/:id/timeline', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const timeline = await campaigns.getCampaignTimeline(campaignId, tenantId);

        res.json({
            ok: true,
            timeline
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/timeline error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/failed
 * @desc Get failed targets with error details
 */
router.get('/:id/failed', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const failedTargets = await campaigns.getFailedTargets(campaignId, tenantId);

        res.json({
            ok: true,
            failed: failedTargets
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/failed error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/top-responders
 * @desc Get top responders for a campaign
 * @query limit - Number of top responders to return (default: 10)
 */
router.get('/:id/top-responders', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;
        const limit = req.query.limit ? Number(req.query.limit) : 10;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const topResponders = await campaigns.getTopResponders(campaignId, tenantId, limit);

        res.json({
            ok: true,
            topResponders
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/top-responders error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/summary/all
 * @desc Get summary of all campaigns for the tenant
 */
router.get('/summary/all', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const summary = await campaigns.getAllCampaignsSummary(tenantId);

        res.json({
            ok: true,
            summary
        });
    } catch (err) {
        logger.error({ err }, '[CAMPAIGNS] GET/summary/all error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/campaigns/:id/schedule
 * @desc Schedule a campaign for future execution
 * @body type - Schedule type ('immediate', 'scheduled', 'recurring')
 * @body start_time - Unix timestamp for scheduled start (optional)
 * @body end_time - Unix timestamp for scheduled end (optional)
 */
router.post('/:id/schedule', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;
        const { type, start_time, end_time } = req.body;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        if (!type) {
            return res.status(400).json({ ok: false, error: 'Schedule type is required' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const scheduleConfig = { type };
        if (start_time) scheduleConfig.startTime = start_time;
        if (end_time) scheduleConfig.endTime = end_time;

        // Validate schedule
        const validation = campaigns.validateSchedule(scheduleConfig);
        if (!validation.valid) {
            return res.status(400).json({
                ok: false,
                error: validation.error
            });
        }

        await campaigns.scheduleCampaign(campaignId, tenantId, scheduleConfig);

        res.json({
            ok: true,
            message: 'Campaign scheduled successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] POST/:id/schedule error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/schedule
 * @desc Get schedule information for a campaign
 */
router.get('/:id/schedule', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const scheduleInfo = await campaigns.getScheduleInfo(campaignId, tenantId);

        res.json({
            ok: true,
            schedule: scheduleInfo
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/schedule error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route DELETE /api/campaigns/:id/schedule
 * @desc Cancel scheduled execution for a campaign
 */
router.delete('/:id/schedule', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        await campaigns.cancelSchedule(campaignId, tenantId);

        res.json({
            ok: true,
            message: 'Schedule cancelled successfully'
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] DELETE/:id/schedule error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/scheduled/list
 * @desc Get all scheduled campaigns for the tenant
 */
router.get('/scheduled/list', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const scheduledCampaigns = await campaigns.getScheduledCampaigns(tenantId);

        res.json({
            ok: true,
            campaigns: scheduledCampaigns
        });
    } catch (err) {
        logger.error({ err }, '[CAMPAIGNS] GET/scheduled/list error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/campaigns/:id/export
 * @desc Export complete campaign data for reporting
 */
router.get('/:id/export', authGuard, async (req, res) => {
    try {
        const campaignId = Number(req.params.id);
        const tenantId = req.user.tenant_id;

        if (!campaignId) {
            return res.status(400).json({ ok: false, error: 'Invalid campaign ID' });
        }

        // Verify campaign belongs to tenant
        const campaign = await campaigns.getCampaign(campaignId, tenantId);
        if (!campaign) {
            return res.status(404).json({ ok: false, error: 'Campaign not found' });
        }

        const exportData = await campaigns.exportCampaignData(campaignId, tenantId);

        res.json({
            ok: true,
            data: exportData
        });
    } catch (err) {
        logger.error({ err, campaignId: req.params.id }, '[CAMPAIGNS] GET/:id/export error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
