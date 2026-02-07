// ===================================================================
// CAMPAIGN RUNNER
// ===================================================================
// Purpose: Execute campaigns by sending messages to targets
// Handles rate limiting, anti-ban measures, and error handling

const db = require('../../database');
const { nowSec } = require('../../utils/time');
const { sleep } = require('../../utils/sleep');
const { CAMPAIGN_STATUS, TARGET_STATUS } = require('./campaign-manager');

/**
 * Default campaign settings
 */
const DEFAULT_SETTINGS = {
    messagesPerMinute: 10,        // Rate limit
    delayBetweenMessages: 6000,   // 6 seconds
    randomDelayMin: 3000,         // Min random delay (3s)
    randomDelayMax: 10000,        // Max random delay (10s)
    batchSize: 50,                // Process in batches
    maxRetries: 3,                // Max retry attempts
    stopOnError: false            // Continue on errors
};

/**
 * Campaign runner class
 */
class CampaignRunner {
    constructor(campaignId, wabaClient) {
        this.campaignId = campaignId;
        this.wabaClient = wabaClient;
        this.isRunning = false;
        this.isPaused = false;
        this.stats = {
            sent: 0,
            failed: 0,
            skipped: 0,
            errors: []
        };
    }

    /**
     * Start campaign execution
     * @returns {Promise<Object>} Execution stats
     */
    async start() {
        if (this.isRunning) {
            throw new Error('Campaign is already running');
        }

        this.isRunning = true;
        this.isPaused = false;

        try {
            // Get campaign details
            const campaign = await db.get(
                `SELECT * FROM campaigns WHERE id = ?`,
                [this.campaignId]
            );

            if (!campaign) {
                throw new Error('Campaign not found');
            }

            if (campaign.status !== CAMPAIGN_STATUS.RUNNING) {
                throw new Error('Campaign is not in running status');
            }

            // Parse settings
            const settings = campaign.settings_json
                ? { ...DEFAULT_SETTINGS, ...JSON.parse(campaign.settings_json) }
                : DEFAULT_SETTINGS;

            // Mark as processing
            await this.markProcessing();

            // Execute campaign
            await this.execute(campaign, settings);

            // Mark as done
            await db.run(
                `UPDATE campaigns SET status = ?, finished_at = ?, processing = 0 WHERE id = ?`,
                [CAMPAIGN_STATUS.DONE, nowSec(), this.campaignId]
            );

            return this.stats;
        } catch (error) {
            console.error('[CampaignRunner] Execution error:', error);

            // Mark as error
            await db.run(
                `UPDATE campaigns SET status = ?, processing = 0 WHERE id = ?`,
                [CAMPAIGN_STATUS.ERROR, this.campaignId]
            );

            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Pause campaign execution
     */
    pause() {
        this.isPaused = true;
    }

    /**
     * Resume campaign execution
     */
    resume() {
        this.isPaused = false;
    }

    /**
     * Stop campaign execution
     */
    stop() {
        this.isRunning = false;
    }

    /**
     * Execute campaign
     * @param {Object} campaign - Campaign object
     * @param {Object} settings - Campaign settings
     * @private
     */
    async execute(campaign, settings) {
        const { batchSize } = settings;
        let offset = 0;
        let hasMore = true;

        while (hasMore && this.isRunning) {
            // Check if paused
            while (this.isPaused && this.isRunning) {
                await sleep(1000);
            }

            if (!this.isRunning) break;

            // Get next batch of queued targets
            const targets = await db.all(
                `SELECT * FROM campaign_targets 
         WHERE campaign_id = ? 
         AND status = ? 
         ORDER BY id ASC 
         LIMIT ?`,
                [this.campaignId, TARGET_STATUS.QUEUED, batchSize]
            );

            if (targets.length === 0) {
                hasMore = false;
                break;
            }

            // Process batch
            for (const target of targets) {
                if (!this.isRunning) break;

                // Check if paused
                while (this.isPaused && this.isRunning) {
                    await sleep(1000);
                }

                await this.sendToTarget(campaign, target, settings);

                // Update heartbeat
                if (this.stats.sent % 10 === 0) {
                    await this.markProcessing();
                }
            }

            offset += targets.length;
        }
    }

    /**
     * Send message to a single target
     * @param {Object} campaign - Campaign object
     * @param {Object} target - Target object
     * @param {Object} settings - Campaign settings
     * @private
     */
    async sendToTarget(campaign, target, settings) {
        const { maxRetries, randomDelayMin, randomDelayMax, delayBetweenMessages } = settings;
        let attempts = 0;
        let sent = false;

        while (attempts < maxRetries && !sent) {
            try {
                // Random delay for anti-ban
                const randomDelay = Math.floor(
                    Math.random() * (randomDelayMax - randomDelayMin) + randomDelayMin
                );
                await sleep(randomDelay);

                // Send message based on media type
                if (campaign.media_file && campaign.media_kind) {
                    await this.sendMediaMessage(campaign, target);
                } else {
                    await this.sendTextMessage(campaign, target);
                }

                // Mark as sent
                await db.run(
                    `UPDATE campaign_targets 
           SET status = ?, sent_ts = ? 
           WHERE id = ?`,
                    [TARGET_STATUS.SENT, nowSec(), target.id]
                );

                this.stats.sent++;
                sent = true;

                // Fixed delay between messages
                await sleep(delayBetweenMessages);

            } catch (error) {
                attempts++;
                console.error(`[CampaignRunner] Error sending to ${target.jid} (attempt ${attempts}):`, error);

                if (attempts >= maxRetries) {
                    // Mark as failed
                    await db.run(
                        `UPDATE campaign_targets 
             SET status = ?, error = ? 
             WHERE id = ?`,
                        [TARGET_STATUS.FAILED, error.message, target.id]
                    );

                    this.stats.failed++;
                    this.stats.errors.push({
                        jid: target.jid,
                        error: error.message
                    });
                } else {
                    // Wait before retry
                    await sleep(5000);
                }
            }
        }
    }

    /**
     * Send text message
     * @param {Object} campaign - Campaign object
     * @param {Object} target - Target object
     * @private
     */
    async sendTextMessage(campaign, target) {
        await this.wabaClient.sendText(target.jid, campaign.text);

        // Log to chats table
        await db.run(
            `INSERT INTO chats (
        tenant_id, acc_id, jid, date, ts, message, type, campaign_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                campaign.tenant_id,
                campaign.acc_id,
                target.jid,
                new Date().toISOString().split('T')[0],
                nowSec(),
                campaign.text,
                'text',
                campaign.id,
                'sent'
            ]
        );
    }

    /**
     * Send media message
     * @param {Object} campaign - Campaign object
     * @param {Object} target - Target object
     * @private
     */
    async sendMediaMessage(campaign, target) {
        const mediaUrl = campaign.media_file.startsWith('http')
            ? campaign.media_file
            : `${process.env.BASE_URL || 'http://localhost:3099'}/uploads/${campaign.media_file}`;

        switch (campaign.media_kind) {
            case 'image':
                await this.wabaClient.sendImage(target.jid, mediaUrl, campaign.text || '');
                break;
            case 'video':
                await this.wabaClient.sendVideo(target.jid, mediaUrl, campaign.text || '');
                break;
            case 'audio':
                await this.wabaClient.sendAudio(target.jid, mediaUrl);
                break;
            case 'document':
                const filename = campaign.media_file.split('/').pop();
                await this.wabaClient.sendDocument(target.jid, mediaUrl, filename, campaign.text || '');
                break;
            default:
                throw new Error(`Unsupported media type: ${campaign.media_kind}`);
        }

        // Log to chats table
        await db.run(
            `INSERT INTO chats (
        tenant_id, acc_id, jid, date, ts, message, type, 
        media_file, media_kind, campaign_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                campaign.tenant_id,
                campaign.acc_id,
                target.jid,
                new Date().toISOString().split('T')[0],
                nowSec(),
                campaign.text || '',
                campaign.media_kind,
                campaign.media_file,
                campaign.media_kind,
                campaign.id,
                'sent'
            ]
        );
    }

    /**
     * Mark campaign as processing (heartbeat)
     * @private
     */
    async markProcessing() {
        await db.run(
            `UPDATE campaigns SET processing_ts = ? WHERE id = ?`,
            [Date.now(), this.campaignId]
        );
    }

    /**
     * Get current stats
     * @returns {Object} Current execution stats
     */
    getStats() {
        return { ...this.stats };
    }
}

/**
 * Create and start a campaign runner
 * @param {number} campaignId - Campaign ID
 * @param {Object} wabaClient - WABA client instance
 * @returns {Promise<CampaignRunner>} Campaign runner instance
 */
async function createRunner(campaignId, wabaClient) {
    const runner = new CampaignRunner(campaignId, wabaClient);
    return runner;
}

module.exports = {
    CampaignRunner,
    createRunner,
    DEFAULT_SETTINGS
};
