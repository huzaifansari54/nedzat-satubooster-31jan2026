// ===================================================================
// CAMPAIGN MANAGER
// ===================================================================
// Purpose: Create, update, and manage campaigns
// Handles campaign CRUD operations and settings

const db = require('../../database');
const { nowSec } = require('../../utils/time');

/**
 * Campaign statuses
 */
const CAMPAIGN_STATUS = {
    DRAFT: 'draft',
    RUNNING: 'running',
    PAUSED: 'paused',
    DONE: 'done',
    ERROR: 'error'
};

/**
 * Target statuses
 */
const TARGET_STATUS = {
    QUEUED: 'queued',
    SENT: 'sent',
    FAILED: 'failed',
    SKIPPED: 'skipped'
};

/**
 * Create a new campaign
 * @param {Object} campaignData - Campaign data
 * @returns {Promise<number>} Campaign ID
 */
async function createCampaign(campaignData) {
    const {
        tenantId,
        accId,
        title,
        text,
        mediaFile = null,
        mediaKind = null,
        settings = {}
    } = campaignData;

    const settingsJson = JSON.stringify(settings);
    const createdAt = nowSec();

    const result = await db.run(
        `INSERT INTO campaigns (
      tenant_id, acc_id, title, text, media_file, media_kind,
      created_at, status, settings_json, processing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tenantId,
            accId,
            title,
            text,
            mediaFile,
            mediaKind,
            createdAt,
            CAMPAIGN_STATUS.DRAFT,
            settingsJson,
            0
        ]
    );

    return result.lastID;
}

/**
 * Get campaign by ID
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID (for security)
 * @returns {Promise<Object|null>} Campaign object or null
 */
async function getCampaign(campaignId, tenantId) {
    const campaign = await db.get(
        `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    if (campaign && campaign.settings_json) {
        try {
            campaign.settings = JSON.parse(campaign.settings_json);
        } catch (e) {
            campaign.settings = {};
        }
    }

    return campaign;
}

/**
 * Get all campaigns for a tenant
 * @param {number} tenantId - Tenant ID
 * @param {Object} filters - Optional filters
 * @returns {Promise<Array>} Array of campaigns
 */
async function getCampaigns(tenantId, filters = {}) {
    let query = `SELECT * FROM campaigns WHERE tenant_id = ?`;
    const params = [tenantId];

    if (filters.status) {
        query += ` AND status = ?`;
        params.push(filters.status);
    }

    if (filters.accId) {
        query += ` AND acc_id = ?`;
        params.push(filters.accId);
    }

    query += ` ORDER BY created_at DESC`;

    if (filters.limit) {
        query += ` LIMIT ?`;
        params.push(filters.limit);
    }

    const campaigns = await db.all(query, params);

    // Parse settings JSON for each campaign
    campaigns.forEach(campaign => {
        if (campaign.settings_json) {
            try {
                campaign.settings = JSON.parse(campaign.settings_json);
            } catch (e) {
                campaign.settings = {};
            }
        }
    });

    return campaigns;
}

/**
 * Update campaign
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID (for security)
 * @param {Object} updates - Fields to update
 * @returns {Promise<boolean>} Success status
 */
async function updateCampaign(campaignId, tenantId, updates) {
    const allowedFields = ['title', 'text', 'media_file', 'media_kind', 'settings_json', 'status'];
    const setClauses = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            setClauses.push(`${key} = ?`);
            params.push(key === 'settings_json' && typeof value === 'object'
                ? JSON.stringify(value)
                : value);
        }
    }

    if (setClauses.length === 0) {
        return false;
    }

    params.push(campaignId, tenantId);

    await db.run(
        `UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`,
        params
    );

    return true;
}

/**
 * Delete campaign
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID (for security)
 * @returns {Promise<boolean>} Success status
 */
async function deleteCampaign(campaignId, tenantId) {
    // Check if campaign is running
    const campaign = await getCampaign(campaignId, tenantId);
    if (!campaign) {
        return false;
    }

    if (campaign.status === CAMPAIGN_STATUS.RUNNING) {
        throw new Error('Cannot delete a running campaign. Pause it first.');
    }

    // Delete campaign targets
    await db.run(
        `DELETE FROM campaign_targets WHERE campaign_id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    // Delete campaign
    await db.run(
        `DELETE FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    return true;
}

/**
 * Add targets to campaign
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {Array<string>} jids - Array of WhatsApp JIDs
 * @returns {Promise<number>} Number of targets added
 */
async function addTargets(campaignId, tenantId, jids) {
    let addedCount = 0;

    for (const jid of jids) {
        try {
            await db.run(
                `INSERT OR IGNORE INTO campaign_targets (
          tenant_id, campaign_id, jid, status
        ) VALUES (?, ?, ?, ?)`,
                [tenantId, campaignId, jid, TARGET_STATUS.QUEUED]
            );
            addedCount++;
        } catch (error) {
            console.error(`[CampaignManager] Error adding target ${jid}:`, error);
        }
    }

    return addedCount;
}

/**
 * Remove target from campaign
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {string} jid - WhatsApp JID
 * @returns {Promise<boolean>} Success status
 */
async function removeTarget(campaignId, tenantId, jid) {
    await db.run(
        `DELETE FROM campaign_targets 
     WHERE campaign_id = ? AND tenant_id = ? AND jid = ?`,
        [campaignId, tenantId, jid]
    );

    return true;
}

/**
 * Get campaign targets
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {Object} filters - Optional filters
 * @returns {Promise<Array>} Array of targets
 */
async function getTargets(campaignId, tenantId, filters = {}) {
    let query = `SELECT * FROM campaign_targets WHERE campaign_id = ? AND tenant_id = ?`;
    const params = [campaignId, tenantId];

    if (filters.status) {
        query += ` AND status = ?`;
        params.push(filters.status);
    }

    query += ` ORDER BY id ASC`;

    if (filters.limit) {
        query += ` LIMIT ?`;
        params.push(filters.limit);
    }

    return await db.all(query, params);
}

/**
 * Get campaign target count by status
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object>} Count by status
 */
async function getTargetCounts(campaignId, tenantId) {
    const result = await db.get(
        `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
     FROM campaign_targets 
     WHERE campaign_id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    return {
        total: result.total || 0,
        queued: result.queued || 0,
        sent: result.sent || 0,
        failed: result.failed || 0,
        skipped: result.skipped || 0
    };
}

/**
 * Update campaign status
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {string} status - New status
 * @returns {Promise<boolean>} Success status
 */
async function updateStatus(campaignId, tenantId, status) {
    const validStatuses = Object.values(CAMPAIGN_STATUS);
    if (!validStatuses.includes(status)) {
        throw new Error(`Invalid status: ${status}`);
    }

    const updates = { status };

    // Set timestamps based on status
    if (status === CAMPAIGN_STATUS.RUNNING) {
        const campaign = await getCampaign(campaignId, tenantId);
        if (!campaign.started_at) {
            await db.run(
                `UPDATE campaigns SET started_at = ? WHERE id = ? AND tenant_id = ?`,
                [nowSec(), campaignId, tenantId]
            );
        }
    } else if (status === CAMPAIGN_STATUS.DONE || status === CAMPAIGN_STATUS.ERROR) {
        await db.run(
            `UPDATE campaigns SET finished_at = ? WHERE id = ? AND tenant_id = ?`,
            [nowSec(), campaignId, tenantId]
        );
    }

    return await updateCampaign(campaignId, tenantId, updates);
}

/**
 * Mark campaign as processing (heartbeat)
 * @param {number} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
async function markProcessing(campaignId) {
    await db.run(
        `UPDATE campaigns SET processing = 1, processing_ts = ? WHERE id = ?`,
        [Date.now(), campaignId]
    );
}

/**
 * Clear processing flag
 * @param {number} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
async function clearProcessing(campaignId) {
    await db.run(
        `UPDATE campaigns SET processing = 0 WHERE id = ?`,
        [campaignId]
    );
}

/**
 * Get stuck campaigns (processing for too long)
 * @param {number} timeoutMs - Timeout in milliseconds (default: 5 minutes)
 * @returns {Promise<Array>} Array of stuck campaigns
 */
async function getStuckCampaigns(timeoutMs = 5 * 60 * 1000) {
    const cutoff = Date.now() - timeoutMs;

    return await db.all(
        `SELECT * FROM campaigns 
     WHERE processing = 1 
     AND processing_ts < ? 
     AND status = ?`,
        [cutoff, CAMPAIGN_STATUS.RUNNING]
    );
}

module.exports = {
    CAMPAIGN_STATUS,
    TARGET_STATUS,
    createCampaign,
    getCampaign,
    getCampaigns,
    updateCampaign,
    deleteCampaign,
    addTargets,
    removeTarget,
    getTargets,
    getTargetCounts,
    updateStatus,
    markProcessing,
    clearProcessing,
    getStuckCampaigns
};
