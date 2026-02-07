// ===================================================================
// CAMPAIGN ANALYTICS
// ===================================================================
// Purpose: Track and analyze campaign performance
// Provides statistics, reports, and insights

const db = require('../../database');

/**
 * Get campaign statistics
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object>} Campaign statistics
 */
async function getCampaignStats(campaignId, tenantId) {
    // Get campaign details
    const campaign = await db.get(
        `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    if (!campaign) {
        return null;
    }

    // Get target counts
    const targetStats = await db.get(
        `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN reply_ts IS NOT NULL THEN 1 ELSE 0 END) as replied
     FROM campaign_targets 
     WHERE campaign_id = ? AND tenant_id = ?`,
        [campaignId, tenantId]
    );

    // Calculate metrics
    const total = targetStats.total || 0;
    const sent = targetStats.sent || 0;
    const replied = targetStats.replied || 0;

    const deliveryRate = total > 0 ? (sent / total) * 100 : 0;
    const responseRate = sent > 0 ? (replied / sent) * 100 : 0;
    const failureRate = total > 0 ? ((targetStats.failed || 0) / total) * 100 : 0;

    // Calculate duration
    let duration = null;
    if (campaign.started_at) {
        const endTime = campaign.finished_at || Date.now() / 1000;
        duration = Math.floor(endTime - campaign.started_at);
    }

    return {
        campaign: {
            id: campaign.id,
            title: campaign.title,
            status: campaign.status,
            created_at: campaign.created_at,
            started_at: campaign.started_at,
            finished_at: campaign.finished_at,
            duration: duration
        },
        targets: {
            total: total,
            queued: targetStats.queued || 0,
            sent: sent,
            failed: targetStats.failed || 0,
            skipped: targetStats.skipped || 0,
            replied: replied
        },
        metrics: {
            deliveryRate: deliveryRate.toFixed(2),
            responseRate: responseRate.toFixed(2),
            failureRate: failureRate.toFixed(2)
        }
    };
}

/**
 * Get campaign responses (messages from targets)
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {number} limit - Maximum number of responses
 * @returns {Promise<Array>} Array of responses
 */
async function getCampaignResponses(campaignId, tenantId, limit = 100) {
    const responses = await db.all(
        `SELECT c.*, ct.sent_ts, ct.reply_ts
     FROM chats c
     JOIN campaign_targets ct ON c.jid = ct.jid AND c.campaign_id = ct.campaign_id
     WHERE c.campaign_id = ? 
     AND c.tenant_id = ? 
     AND c.type = 'chat'
     AND ct.reply_ts IS NOT NULL
     ORDER BY c.ts DESC
     LIMIT ?`,
        [campaignId, tenantId, limit]
    );

    return responses;
}

/**
 * Get campaign timeline (hourly breakdown)
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Array>} Hourly statistics
 */
async function getCampaignTimeline(campaignId, tenantId) {
    const timeline = await db.all(
        `SELECT 
      strftime('%Y-%m-%d %H:00:00', datetime(sent_ts, 'unixepoch')) as hour,
      COUNT(*) as sent_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN reply_ts IS NOT NULL THEN 1 ELSE 0 END) as reply_count
     FROM campaign_targets
     WHERE campaign_id = ? AND tenant_id = ?
     AND sent_ts IS NOT NULL
     GROUP BY hour
     ORDER BY hour ASC`,
        [campaignId, tenantId]
    );

    return timeline;
}

/**
 * Get failed targets with error details
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Array>} Failed targets
 */
async function getFailedTargets(campaignId, tenantId) {
    const failed = await db.all(
        `SELECT jid, error, sent_ts
     FROM campaign_targets
     WHERE campaign_id = ? 
     AND tenant_id = ?
     AND status = 'failed'
     ORDER BY id ASC`,
        [campaignId, tenantId]
    );

    return failed;
}

/**
 * Get top responders (targets with most replies)
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @param {number} limit - Number of top responders
 * @returns {Promise<Array>} Top responders
 */
async function getTopResponders(campaignId, tenantId, limit = 10) {
    const responders = await db.all(
        `SELECT 
      c.jid,
      COUNT(*) as message_count,
      MIN(c.ts) as first_reply_ts,
      MAX(c.ts) as last_reply_ts
     FROM chats c
     JOIN campaign_targets ct ON c.jid = ct.jid AND c.campaign_id = ct.campaign_id
     WHERE c.campaign_id = ? 
     AND c.tenant_id = ?
     AND c.type = 'chat'
     GROUP BY c.jid
     ORDER BY message_count DESC
     LIMIT ?`,
        [campaignId, tenantId, limit]
    );

    return responders;
}

/**
 * Get all campaigns summary for a tenant
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Array>} Campaigns summary
 */
async function getAllCampaignsSummary(tenantId) {
    const campaigns = await db.all(
        `SELECT 
      c.id,
      c.title,
      c.status,
      c.created_at,
      c.started_at,
      c.finished_at,
      COUNT(ct.id) as total_targets,
      SUM(CASE WHEN ct.status = 'sent' THEN 1 ELSE 0 END) as sent_count,
      SUM(CASE WHEN ct.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN ct.reply_ts IS NOT NULL THEN 1 ELSE 0 END) as reply_count
     FROM campaigns c
     LEFT JOIN campaign_targets ct ON c.id = ct.campaign_id
     WHERE c.tenant_id = ?
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
        [tenantId]
    );

    // Calculate metrics for each campaign
    campaigns.forEach(campaign => {
        const total = campaign.total_targets || 0;
        const sent = campaign.sent_count || 0;
        const replied = campaign.reply_count || 0;

        campaign.delivery_rate = total > 0 ? ((sent / total) * 100).toFixed(2) : '0.00';
        campaign.response_rate = sent > 0 ? ((replied / sent) * 100).toFixed(2) : '0.00';
        campaign.failure_rate = total > 0 ? (((campaign.failed_count || 0) / total) * 100).toFixed(2) : '0.00';
    });

    return campaigns;
}

/**
 * Get response time analysis
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object>} Response time statistics
 */
async function getResponseTimeAnalysis(campaignId, tenantId) {
    const data = await db.all(
        `SELECT 
      (reply_ts - sent_ts) as response_time
     FROM campaign_targets
     WHERE campaign_id = ? 
     AND tenant_id = ?
     AND reply_ts IS NOT NULL
     AND sent_ts IS NOT NULL
     ORDER BY response_time ASC`,
        [campaignId, tenantId]
    );

    if (data.length === 0) {
        return {
            count: 0,
            average: 0,
            median: 0,
            min: 0,
            max: 0
        };
    }

    const times = data.map(d => d.response_time);
    const sum = times.reduce((a, b) => a + b, 0);
    const average = sum / times.length;
    const median = times[Math.floor(times.length / 2)];
    const min = Math.min(...times);
    const max = Math.max(...times);

    return {
        count: times.length,
        average: Math.floor(average),
        median: median,
        min: min,
        max: max
    };
}

/**
 * Export campaign data for reporting
 * @param {number} campaignId - Campaign ID
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object>} Complete campaign data
 */
async function exportCampaignData(campaignId, tenantId) {
    const stats = await getCampaignStats(campaignId, tenantId);
    const timeline = await getCampaignTimeline(campaignId, tenantId);
    const failed = await getFailedTargets(campaignId, tenantId);
    const topResponders = await getTopResponders(campaignId, tenantId);
    const responseTime = await getResponseTimeAnalysis(campaignId, tenantId);

    return {
        stats,
        timeline,
        failed,
        topResponders,
        responseTime,
        exportedAt: new Date().toISOString()
    };
}

module.exports = {
    getCampaignStats,
    getCampaignResponses,
    getCampaignTimeline,
    getFailedTargets,
    getTopResponders,
    getAllCampaignsSummary,
    getResponseTimeAnalysis,
    exportCampaignData
};
