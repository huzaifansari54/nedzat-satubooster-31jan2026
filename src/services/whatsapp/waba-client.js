// ===================================================================
// META WHATSAPP BUSINESS API (WABA) CLIENT
// ===================================================================
// Extracted from: waba.js (root directory)
// Purpose: WhatsApp Business API client for Meta Cloud API

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

/**
 * WABA Client for Meta Cloud API
 * Handles all WhatsApp Business API operations including:
 * - Sending messages (text, image, video, audio, document)
 * - Media upload/download
 * - Message reactions
 * - Read receipts
 * - Webhook verification
 */
class WABAClient {
    /**
     * Create a new WABA client instance
     * @param {string} phoneNumberId - WhatsApp phone number ID from Meta
     * @param {string} accessToken - Meta access token
     */
    constructor(phoneNumberId, accessToken) {
        this.phoneNumberId = phoneNumberId;
        this.accessToken = accessToken;
        this.baseURL = 'https://graph.facebook.com/v18.0';
    }

    /**
     * Get media metadata by media_id
     * @param {string} mediaId - Media ID from WhatsApp
     * @returns {Promise<Object>} Meta Cloud API response: { url, mime_type, sha256, file_size, id }
     */
    async getMediaInfo(mediaId) {
        const url = `${this.baseURL}/${encodeURIComponent(String(mediaId))}`;
        const r = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        return r.data;
    }

    /**
     * Download media by media_id
     * @param {string} mediaId - Media ID from WhatsApp
     * @returns {Promise<Object>} { buffer, mime_type, file_size, id }
     */
    async downloadMedia(mediaId) {
        const info = await this.getMediaInfo(mediaId);
        const dlUrl = info?.url;
        if (!dlUrl) throw new Error('WABA media url missing');

        const r = await axios.get(dlUrl, {
            responseType: 'arraybuffer',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        return {
            buffer: Buffer.from(r.data),
            mime_type: String(info?.mime_type || r.headers?.['content-type'] || ''),
            file_size: Number(info?.file_size || 0),
            id: String(info?.id || mediaId)
        };
    }

    /**
     * Download media by media_id and save to file (useful for ffmpeg/whisper)
     * @param {string} mediaId - Media ID from WhatsApp
     * @param {string} outDir - Output directory path
     * @returns {Promise<Object>} { filePath, mime_type, file_size, id }
     */
    async downloadMediaToFile(mediaId, outDir) {
        const info = await this.getMediaInfo(mediaId);
        const dlUrl = info?.url;
        if (!dlUrl) throw new Error('WABA media url missing');

        // Determine file extension from MIME type
        const mime = String(info?.mime_type || '');
        let ext = '.bin';
        if (mime.includes('ogg')) ext = '.ogg';
        else if (mime.includes('mpeg')) ext = '.mp3';
        else if (mime.includes('mp4')) ext = '.mp4';
        else if (mime.includes('m4a') || mime.includes('aac')) ext = '.m4a';
        else if (mime.includes('webm')) ext = '.webm';
        else if (mime.includes('jpeg')) ext = '.jpg';
        else if (mime.includes('png')) ext = '.png';
        else if (mime.includes('pdf')) ext = '.pdf';
        else if (mime.includes('zip')) ext = '.zip';

        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `${String(info?.id || mediaId)}${ext}`);

        // ⚠️ Important: Download URL also requires Authorization Bearer
        const r = await axios.get(dlUrl, {
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });

        await new Promise((resolve, reject) => {
            const w = fs.createWriteStream(outPath);
            r.data.pipe(w);
            w.on('finish', resolve);
            w.on('error', reject);
        });

        return {
            filePath: outPath,
            mime_type: mime,
            file_size: Number(info?.file_size || 0),
            id: String(info?.id || mediaId)
        };
    }

    /**
     * Send reaction to a message. emoji="" removes reaction.
     * @param {string} to - Recipient phone number
     * @param {string} messageId - Message ID to react to
     * @param {string} emoji - Emoji to react with (empty string to remove)
     * @returns {Promise<Object>} API response
     */
    async sendReaction(to, messageId, emoji) {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;
        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'reaction',
            reaction: {
                message_id: String(messageId),
                emoji: String(emoji ?? '')
            }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log('[WABA] Reaction sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send reaction error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send text message
     * @param {string} to - Recipient phone number
     * @param {string} text - Message text
     * @returns {Promise<Object>} API response
     */
    async sendText(to, text) {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'text',
            text: { body: text }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Text sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send text error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send image message
     * @param {string} to - Recipient phone number
     * @param {string} imageUrl - Image URL
     * @param {string} caption - Optional caption
     * @returns {Promise<Object>} API response
     */
    async sendImage(to, imageUrl, caption = '') {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'image',
            image: {
                link: imageUrl,
                caption: caption
            }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Image sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send image error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send video message
     * @param {string} to - Recipient phone number
     * @param {string} videoUrl - Video URL
     * @param {string} caption - Optional caption
     * @returns {Promise<Object>} API response
     */
    async sendVideo(to, videoUrl, caption = '') {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'video',
            video: {
                link: videoUrl,
                caption: caption
            }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Video sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send video error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send audio message (voice note)
     * @param {string} to - Recipient phone number
     * @param {string} audioUrl - Audio URL
     * @returns {Promise<Object>} API response
     */
    async sendAudio(to, audioUrl) {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'audio',
            audio: {
                link: audioUrl
            }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Audio sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send audio error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send document message
     * @param {string} to - Recipient phone number
     * @param {string} documentUrl - Document URL
     * @param {string} filename - Document filename
     * @param {string} caption - Optional caption
     * @returns {Promise<Object>} API response
     */
    async sendDocument(to, documentUrl, filename, caption = '') {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: 'document',
            document: {
                link: documentUrl,
                filename: filename,
                caption: caption
            }
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Document sent:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send document error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Upload media to Meta servers (for large files)
     * @param {string} filePath - Local file path
     * @param {string} mimeType - MIME type of the file
     * @returns {Promise<string>} Media ID
     */
    async uploadMedia(filePath, mimeType) {
        const url = `${this.baseURL}/${this.phoneNumberId}/media`;

        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        formData.append('file', fs.createReadStream(filePath), {
            contentType: mimeType,
            filename: path.basename(filePath)
        });

        try {
            const response = await axios.post(url, formData, {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    ...formData.getHeaders()
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log('[WABA] Media uploaded:', response.data);
            return response.data.id; // Returns media_id
        } catch (error) {
            console.error('[WABA] Upload media error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send media by media_id (after upload)
     * @param {string} to - Recipient phone number
     * @param {string} mediaId - Media ID from upload
     * @param {string} mediaType - Media type: 'image', 'video', 'audio', 'document'
     * @param {string} caption - Optional caption
     * @returns {Promise<Object>} API response
     */
    async sendMediaById(to, mediaId, mediaType, caption = '') {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.formatPhone(to),
            type: mediaType, // 'image', 'video', 'audio', 'document'
            [mediaType]: {
                id: mediaId
            }
        };

        if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
            body[mediaType].caption = caption;
        }

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('[WABA] Media sent by ID:', response.data);
            return response.data;
        } catch (error) {
            console.error('[WABA] Send media by ID error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Mark message as read
     * @param {string} messageId - Message ID to mark as read
     * @returns {Promise<Object>} API response
     */
    async markAsRead(messageId) {
        const url = `${this.baseURL}/${this.phoneNumberId}/messages`;

        const body = {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error) {
            console.error('[WABA] Mark as read error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Format phone number (remove + and @s.whatsapp.net)
     * @param {string} phone - Phone number to format
     * @returns {string} Formatted phone number
     */
    formatPhone(phone) {
        const p = String(phone || '');
        return p.replace(/\+/g, '').replace(/@s\.whatsapp\.net/g, '').replace(/\D/g, '');
    }

    /**
     * Webhook verification (for Meta webhook setup)
     * @param {string} mode - Verification mode
     * @param {string} token - Verification token
     * @param {string} challenge - Challenge string
     * @param {string} verifyToken - Expected verify token
     * @returns {string|null} Challenge if verified, null otherwise
     */
    static verifyWebhook(mode, token, challenge, verifyToken) {
        if (mode === 'subscribe' && token === verifyToken) {
            console.log('[WABA] Webhook verified');
            return challenge;
        }
        return null;
    }
}

module.exports = WABAClient;
