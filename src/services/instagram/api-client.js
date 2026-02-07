/**
 * Instagram Graph API Client
 * Handles all interactions with Meta's Instagram Graph API
 */

const axios = require('axios');

const IG_GRAPH_API_BASE = 'https://graph.facebook.com/v18.0';

class InstagramAPIClient {
    constructor(accessToken) {
        this.accessToken = accessToken;
    }

    /**
     * Send a direct message to a user
     * @param {string} recipientId - Instagram-scoped user ID (IGSID)
     * @param {string} message - Message text
     * @returns {Promise<object>} API response
     */
    async sendDirectMessage(recipientId, message) {
        const url = `${IG_GRAPH_API_BASE}/me/messages`;

        const payload = {
            recipient: { id: recipientId },
            message: { text: message }
        };

        const response = await axios.post(url, payload, {
            params: { access_token: this.accessToken },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Reply to a comment
     * @param {string} commentId - Comment ID
     * @param {string} message - Reply text
     * @returns {Promise<object>} API response
     */
    async replyToComment(commentId, message) {
        const url = `${IG_GRAPH_API_BASE}/${commentId}/replies`;

        const response = await axios.post(url,
            { message },
            {
                params: { access_token: this.accessToken },
                timeout: 15000
            }
        );

        return response.data;
    }

    /**
     * Reply to a story mention
     * @param {string} storyId - Story ID
     * @param {string} message - Reply text
     * @returns {Promise<object>} API response
     */
    async replyToStory(storyId, message) {
        const url = `${IG_GRAPH_API_BASE}/${storyId}/replies`;

        const response = await axios.post(url,
            { message },
            {
                params: { access_token: this.accessToken },
                timeout: 15000
            }
        );

        return response.data;
    }

    /**
     * Get user profile information
     * @param {string} userId - Instagram user ID
     * @param {string[]} fields - Fields to retrieve
     * @returns {Promise<object>} User profile data
     */
    async getUserProfile(userId, fields = ['id', 'username', 'name', 'profile_picture_url']) {
        const url = `${IG_GRAPH_API_BASE}/${userId}`;

        const response = await axios.get(url, {
            params: {
                fields: fields.join(','),
                access_token: this.accessToken
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Get conversation/thread messages
     * @param {string} threadId - Conversation thread ID
     * @param {number} limit - Number of messages to retrieve
     * @returns {Promise<object>} Messages data
     */
    async getThreadMessages(threadId, limit = 25) {
        const url = `${IG_GRAPH_API_BASE}/${threadId}`;

        const response = await axios.get(url, {
            params: {
                fields: 'messages{id,created_time,from,to,message,attachments}',
                limit,
                access_token: this.accessToken
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Get Instagram Business Account info
     * @param {string} igUserId - Instagram User ID
     * @returns {Promise<object>} Account info
     */
    async getAccountInfo(igUserId) {
        const url = `${IG_GRAPH_API_BASE}/${igUserId}`;

        const response = await axios.get(url, {
            params: {
                fields: 'id,username,name,profile_picture_url,followers_count,follows_count,media_count',
                access_token: this.accessToken
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Exchange short-lived token for long-lived token
     * @param {string} shortLivedToken - Short-lived access token
     * @param {string} appId - Instagram App ID
     * @param {string} appSecret - Instagram App Secret
     * @returns {Promise<object>} Long-lived token data
     */
    static async exchangeToken(shortLivedToken, appId, appSecret) {
        const url = `${IG_GRAPH_API_BASE}/oauth/access_token`;

        const response = await axios.get(url, {
            params: {
                grant_type: 'ig_exchange_token',
                client_id: appId,
                client_secret: appSecret,
                access_token: shortLivedToken
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Refresh long-lived token (before expiration)
     * @param {string} longLivedToken - Current long-lived token
     * @returns {Promise<object>} Refreshed token data
     */
    static async refreshToken(longLivedToken) {
        const url = `${IG_GRAPH_API_BASE}/refresh_access_token`;

        const response = await axios.get(url, {
            params: {
                grant_type: 'ig_refresh_token',
                access_token: longLivedToken
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * Subscribe to webhooks
     * @param {string} pageId - Facebook Page ID
     * @param {string} accessToken - Page access token
     * @param {string[]} fields - Webhook fields to subscribe to
     * @returns {Promise<object>} Subscription response
     */
    static async subscribeToWebhooks(pageId, accessToken, fields = ['messages', 'messaging_postbacks', 'message_echoes']) {
        const url = `${IG_GRAPH_API_BASE}/${pageId}/subscribed_apps`;

        const response = await axios.post(url,
            { subscribed_fields: fields.join(',') },
            {
                params: { access_token: accessToken },
                timeout: 15000
            }
        );

        return response.data;
    }
}

module.exports = InstagramAPIClient;
