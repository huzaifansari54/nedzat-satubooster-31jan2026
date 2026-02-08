/**
 * Gupshup Message Sender
 * Handles sending WhatsApp messages via Gupshup API
 */

const axios = require('axios');
const config = require('../../config');

/**
 * Send WhatsApp message via Gupshup
 * @param {object} params - Message parameters
 * @param {string} params.appId - Gupshup app ID
 * @param {string} params.appToken - Gupshup app token
 * @param {string} params.to - Recipient phone number (without @s.whatsapp.net)
 * @param {string} params.text - Message text
 * @param {string} [params.mediaUrl] - Media URL (for image/video/document/audio)
 * @param {string} [params.mediaType] - Media type: 'image', 'video', 'document', 'audio'
 * @returns {Promise<object>} Send response
 * @throws {Error} If sending fails
 */
async function sendMessage({ appId, appToken, to, text, mediaUrl, mediaType }) {
    // Clean phone number (remove @s.whatsapp.net and non-digits)
    const cleanTo = String(to || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');

    if (!cleanTo) {
        throw new Error('Invalid recipient phone number');
    }

    if (!appId || !appToken) {
        throw new Error('Gupshup app ID and token are required');
    }

    const url = `${config.gupshup.baseUrl}/partner/app/${appId}/v3/message`;

    // Build form data
    const form = new URLSearchParams();
    form.set('messaging_product', 'whatsapp');
    form.set('recipient_type', 'individual');
    form.set('to', cleanTo);

    // Handle media messages
    if (mediaUrl && mediaType && /^https?:\/\//i.test(mediaUrl)) {
        form.set('type', mediaType);

        switch (mediaType) {
            case 'image':
                form.set('image', JSON.stringify({ link: mediaUrl, caption: text || '' }));
                break;
            case 'video':
                form.set('video', JSON.stringify({ link: mediaUrl, caption: text || '' }));
                break;
            case 'document':
                form.set('document', JSON.stringify({ link: mediaUrl, caption: text || '' }));
                break;
            case 'audio':
                form.set('audio', JSON.stringify({ link: mediaUrl }));
                break;
            default:
                // Fallback to text if media type is unknown
                form.set('type', 'text');
                form.set('text', JSON.stringify({ body: text || '' }));
        }
    } else {
        // Text-only message
        form.set('type', 'text');
        form.set('text', JSON.stringify({ body: text || '' }));
    }

    try {
        const resp = await axios.post(url, form.toString(), {
            headers: {
                Authorization: String(appToken),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 20000
        });

        return resp.data;
    } catch (error) {
        console.error('[GUPSHUP][SEND] Message send failed:', error?.response?.data || error?.message || error);
        throw error;
    }
}

module.exports = {
    sendMessage
};
