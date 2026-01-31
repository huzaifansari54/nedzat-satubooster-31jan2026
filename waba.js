// ===================================================================
// META WHATSAPP BUSINESS API (WABA) INTEGRATION
// ===================================================================

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

/**
 * WABA Client для работы с Meta Cloud API
 */
class WABAClient {
  constructor(phoneNumberId, accessToken) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.baseURL = 'https://graph.facebook.com/v18.0';
  }

  /**
   * Получить метаданные медиа по media_id
   * Возвращает объект Meta Cloud API: { url, mime_type, sha256, file_size, id }
   */
  async getMediaInfo(mediaId) {
    const url = `${this.baseURL}/${encodeURIComponent(String(mediaId))}`;
    const r = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    return r.data;
  }

  /**
   * Скачать медиа по media_id
   * Возвращает: { buffer, mime_type, file_size, id }
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
   * Скачать медиа по media_id и сохранить в файл (удобно для ffmpeg/whisper)
   * Возвращает: { filePath, mime_type, file_size, id }
   */
  async downloadMediaToFile(mediaId, outDir) {
    const info = await this.getMediaInfo(mediaId);
    const dlUrl = info?.url;
    if (!dlUrl) throw new Error('WABA media url missing');

    // mime
    const mime = String(info?.mime_type || '');
    // ext по mime
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

    // ⚠️ важно: скачивание по url тоже требует Authorization Bearer
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
   * Отправка реакции на сообщение. emoji="" снимает реакцию.
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
   * Отправка текстового сообщения
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
   * Отправка изображения
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
   * Отправка видео
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
   * Отправка аудио (голосовое)
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
   * Отправка документа
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
   * Загрузка медиа на сервера Meta (для больших файлов)
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
      return response.data.id; // Возвращает media_id
    } catch (error) {
      console.error('[WABA] Upload media error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Отправка медиа по media_id (после загрузки)
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
   * Отметить сообщение как прочитанное
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
   * Форматирование телефона (удаление + и @s.whatsapp.net)
   */
  formatPhone(phone) {
    const p = String(phone || '');
    return p.replace(/\+/g, '').replace(/@s\.whatsapp\.net/g, '').replace(/\D/g, '');
  }

  /**
   * Webhook verification (для настройки в Meta)
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
