// ===================================================================
// CAMPAIGN SCHEDULER
// ===================================================================
// Purpose: Schedule campaigns for future execution
// Handles delayed starts, recurring campaigns, and time-based triggers

const db = require('../../database');
const { nowSec } = require('../../utils/time');
const { CAMPAIGN_STATUS } = require('./campaign-manager');

/**
 * Schedule types
 */
const SCHEDULE_TYPE = {
    IMMEDIATE: 'immediate',
    SCHEDULED: 'scheduled',
    RECURRING: 'recurring'
};

/**
 * Schedule a campaign for future execution
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {Object} scheduleConfig - Schedule configuration
 * @returns {Promise<boolean>} Success status
 */
async function scheduleCampaign(campaignId, tenantId, scheduleConfig) {
    const {
        type = SCHEDULE_TYPE.IMMEDIATE,
        startTime = null,
        endTime = null,
        recurrence = null
    } = scheduleConfig;

    // Validate campaign exists and belongs to tenant
    const campaign = await db.get(
        `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    if (!campaign) {
        throw new Error('Campaign not found');
    }

    // Update campaign settings with schedule
    const settings = campaign.settings_json
        ? JSON.parse(campaign.settings_json)
        : {};

    settings.schedule = {
        type,
        startTime,
        endTime,
        recurrence,
        scheduledAt: nowSec()
    };

    await db.run(
        `UPDATE campaigns SET settings_json = ? WHERE id = ?`,
        [JSON.stringify(settings), campaignId]
    );

    return true;
}

/**
 * Get campaigns ready to start
 * @returns {Promise<Array>} Campaigns ready to start
 */
async function getCampaignsReadyToStart() {
    const now = nowSec();

    const campaigns = await db.all(
        `SELECT * FROM campaigns WHERE status = ?`,
        [CAMPAIGN_STATUS.DRAFT]
    );

    const ready = [];

    for (const campaign of campaigns) {
        if (!campaign.settings_json) continue;

        try {
            const settings = JSON.parse(campaign.settings_json);
            const schedule = settings.schedule;

            if (!schedule) continue;

            // Check if it's time to start
            if (schedule.type === SCHEDULE_TYPE.IMMEDIATE) {
                ready.push(campaign);
            } else if (schedule.type === SCHEDULE_TYPE.SCHEDULED) {
                if (schedule.startTime && schedule.startTime <= now) {
                    ready.push(campaign);
                }
            }
        } catch (error) {
            console.error(`[Scheduler] Error parsing settings for campaign ${campaign.id}:`, error);
        }
    }

    return ready;
}

/**
 * Get running campaigns that should be paused
 * @returns {Promise<Array>} Campaigns to pause
 */
async function getCampaignsToPause() {
    const now = nowSec();

    const campaigns = await db.all(
        `SELECT * FROM campaigns WHERE status = ?`,
        [CAMPAIGN_STATUS.RUNNING]
    );

    const toPause = [];

    for (const campaign of campaigns) {
        if (!campaign.settings_json) continue;

        try {
            const settings = JSON.parse(campaign.settings_json);
            const schedule = settings.schedule;

            if (!schedule || !schedule.endTime) continue;

            // Check if it's time to pause
            if (schedule.endTime && schedule.endTime <= now) {
                toPause.push(campaign);
            }
        } catch (error) {
            console.error(`[Scheduler] Error parsing settings for campaign ${campaign.id}:`, error);
        }
    }

    return toPause;
}

/**
 * Auto-start scheduled campaigns
 * This should be called periodically (e.g., every minute)
 * @returns {Promise<Array>} Started campaign IDs
 */
async function autoStartCampaigns() {
    const ready = await getCampaignsReadyToStart();
    const started = [];

    for (const campaign of ready) {
        try {
            await db.run(
                `UPDATE campaigns SET status = ?, started_at = ? WHERE id = ?`,
                [CAMPAIGN_STATUS.RUNNING, nowSec(), campaign.id]
            );

            started.push(campaign.id);
            console.log(`[Scheduler] Auto-started campaign ${campaign.id}`);
        } catch (error) {
            console.error(`[Scheduler] Error starting campaign ${campaign.id}:`, error);
        }
    }

    return started;
}

/**
 * Auto-pause campaigns that reached end time
 * This should be called periodically (e.g., every minute)
 * @returns {Promise<Array>} Paused campaign IDs
 */
async function autoPauseCampaigns() {
    const toPause = await getCampaignsToPause();
    const paused = [];

    for (const campaign of toPause) {
        try {
            await db.run(
                `UPDATE campaigns SET status = ?, finished_at = ? WHERE id = ?`,
                [CAMPAIGN_STATUS.PAUSED, nowSec(), campaign.id]
            );

            paused.push(campaign.id);
            console.log(`[Scheduler] Auto-paused campaign ${campaign.id}`);
        } catch (error) {
            console.error(`[Scheduler] Error pausing campaign ${campaign.id}:`, error);
        }
    }

    return paused;
}

/**
 * Get campaign schedule info
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object|null>} Schedule info or null
 */
async function getScheduleInfo(campaignId, tenantId) {
    const campaign = await db.get(
        `SELECT settings_json FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    if (!campaign || !campaign.settings_json) {
        return null;
    }

    try {
        const settings = JSON.parse(campaign.settings_json);
        return settings.schedule || null;
    } catch (error) {
        console.error(`[Scheduler] Error parsing settings:`, error);
        return null;
    }
}

/**
 * Cancel scheduled campaign
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<boolean>} Success status
 */
async function cancelSchedule(campaignId, tenantId) {
    const campaign = await db.get(
        `SELECT settings_json FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    if (!campaign) {
        return false;
    }

    const settings = campaign.settings_json
        ? JSON.parse(campaign.settings_json)
        : {};

    delete settings.schedule;

    await db.run(
        `UPDATE campaigns SET settings_json = ? WHERE id = ?`,
        [JSON.stringify(settings), campaignId]
    );

    return true;
}

/**
 * Get all scheduled campaigns for a tenant
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Array>} Scheduled campaigns
 */
async function getScheduledCampaigns(tenantId) {
    const campaigns = await db.all(
        `SELECT * FROM campaigns WHERE tenant_id = ? AND status IN (?, ?)`,
        [tenantId, CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.PAUSED]
    );

    const scheduled = [];

    for (const campaign of campaigns) {
        if (!campaign.settings_json) continue;

        try {
            const settings = JSON.parse(campaign.settings_json);
            if (settings.schedule) {
                campaign.schedule = settings.schedule;
                scheduled.push(campaign);
            }
        } catch (error) {
            console.error(`[Scheduler] Error parsing settings for campaign ${campaign.id}:`, error);
        }
    }

    return scheduled;
}

/**
 * Validate schedule configuration
 * @param {Object} scheduleConfig - Schedule configuration
 * @returns {Object} Validation result
 */
function validateSchedule(scheduleConfig) {
    const { type, startTime, endTime } = scheduleConfig;

    const errors = [];

    if (!type || !Object.values(SCHEDULE_TYPE).includes(type)) {
        errors.push('Invalid schedule type');
    }

    if (type === SCHEDULE_TYPE.SCHEDULED && !startTime) {
        errors.push('Start time is required for scheduled campaigns');
    }

    if (startTime && endTime && startTime >= endTime) {
        errors.push('End time must be after start time');
    }

    if (startTime && startTime < nowSec()) {
        errors.push('Start time cannot be in the past');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    SCHEDULE_TYPE,
    scheduleCampaign,
    getCampaignsReadyToStart,
    getCampaignsToPause,
    autoStartCampaigns,
    autoPauseCampaigns,
    getScheduleInfo,
    cancelSchedule,
    getScheduledCampaigns,
    validateSchedule
};
