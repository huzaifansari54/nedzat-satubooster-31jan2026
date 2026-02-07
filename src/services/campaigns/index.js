// ===================================================================
// CAMPAIGN SERVICES - MAIN EXPORT
// ===================================================================
// Centralized export for all campaign-related services

const campaignManager = require('./campaign-manager');
const campaignRunner = require('./campaign-runner');
const campaignAnalytics = require('./campaign-analytics');
const campaignScheduler = require('./campaign-scheduler');

// Export all campaign services
module.exports = {
    // Campaign Manager
    ...campaignManager,

    // Campaign Runner
    CampaignRunner: campaignRunner.CampaignRunner,
    createRunner: campaignRunner.createRunner,
    DEFAULT_SETTINGS: campaignRunner.DEFAULT_SETTINGS,

    // Campaign Analytics
    getCampaignStats: campaignAnalytics.getCampaignStats,
    getCampaignResponses: campaignAnalytics.getCampaignResponses,
    getCampaignTimeline: campaignAnalytics.getCampaignTimeline,
    getFailedTargets: campaignAnalytics.getFailedTargets,
    getTopResponders: campaignAnalytics.getTopResponders,
    getAllCampaignsSummary: campaignAnalytics.getAllCampaignsSummary,
    getResponseTimeAnalysis: campaignAnalytics.getResponseTimeAnalysis,
    exportCampaignData: campaignAnalytics.exportCampaignData,

    // Campaign Scheduler
    SCHEDULE_TYPE: campaignScheduler.SCHEDULE_TYPE,
    scheduleCampaign: campaignScheduler.scheduleCampaign,
    getCampaignsReadyToStart: campaignScheduler.getCampaignsReadyToStart,
    getCampaignsToPause: campaignScheduler.getCampaignsToPause,
    autoStartCampaigns: campaignScheduler.autoStartCampaigns,
    autoPauseCampaigns: campaignScheduler.autoPauseCampaigns,
    getScheduleInfo: campaignScheduler.getScheduleInfo,
    cancelSchedule: campaignScheduler.cancelSchedule,
    getScheduledCampaigns: campaignScheduler.getScheduledCampaigns,
    validateSchedule: campaignScheduler.validateSchedule
};
