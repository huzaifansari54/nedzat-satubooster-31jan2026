# WhatsApp Services

This module provides comprehensive WhatsApp Business API integration for the NeDzat CRM platform.

## 📁 Structure

```
src/services/whatsapp/
├── index.js              # Main export - import from here
├── waba-client.js        # Meta WhatsApp Business API client
├── message-handler.js    # Message parsing and database operations
└── media-handler.js      # Media validation and optimization
```

## 🚀 Quick Start

### Import Services

```javascript
// Import everything
const whatsapp = require('./src/services/whatsapp');

// Or import specific services
const { WABAClient, parseIncomingMessage, validateMedia } = require('./src/services/whatsapp');
```

### Send a Message

```javascript
const { createWABAClient } = require('./src/services/whatsapp');

// Create client instance
const client = createWABAClient(phoneNumberId, accessToken);

// Send text message
await client.sendText('77001234567', 'Hello from NeDzat!');

// Send image with caption
await client.sendImage(
  '77001234567',
  'https://example.com/image.jpg',
  'Check this out!'
);

// Send document
await client.sendDocument(
  '77001234567',
  'https://example.com/report.pdf',
  'Monthly Report.pdf',
  'Here is your monthly report'
);
```

### Process Incoming Messages

```javascript
const { parseIncomingMessage, saveIncomingMessage } = require('./src/services/whatsapp');

// In your webhook handler
app.post('/webhook/whatsapp', async (req, res) => {
  const webhookData = req.body;
  
  // Parse incoming message
  const message = parseIncomingMessage(webhookData);
  
  if (message) {
    // Save to database
    const messageId = await saveIncomingMessage(
      message,
      accountId,
      tenantId
    );
    
    console.log('Message saved:', messageId);
  }
  
  res.sendStatus(200);
});
```

### Handle Media

```javascript
const {
  validateMedia,
  optimizeImage,
  MEDIA_TYPES,
  MAX_FILE_SIZES
} = require('./src/services/whatsapp');

// Validate uploaded file
const validation = await validateMedia(
  '/path/to/image.jpg',
  MEDIA_TYPES.IMAGE
);

if (!validation.valid) {
  console.error('Validation failed:', validation.error);
  return;
}

// Optimize image for WhatsApp
await optimizeImage(
  '/path/to/image.jpg',
  '/path/to/optimized.jpg',
  {
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 80
  }
);

// Upload to Meta
const mediaId = await client.uploadMedia(
  '/path/to/optimized.jpg',
  validation.mimeType
);

// Send by media ID
await client.sendMediaById(
  '77001234567',
  mediaId,
  MEDIA_TYPES.IMAGE,
  'Optimized image'
);
```

### Download Media from WhatsApp

```javascript
const { createWABAClient } = require('./src/services/whatsapp');

const client = createWABAClient(phoneNumberId, accessToken);

// Download to buffer
const media = await client.downloadMedia(mediaId);
console.log('Downloaded:', media.mime_type, media.file_size);

// Or download to file
const result = await client.downloadMediaToFile(
  mediaId,
  './downloads'
);
console.log('Saved to:', result.filePath);
```

### Get Chat History

```javascript
const { getChatHistory, getUnreadCount } = require('./src/services/whatsapp');

// Get last 50 messages
const messages = await getChatHistory(contactId, 50);

// Get unread count
const unreadCount = await getUnreadCount(contactId);
console.log('Unread messages:', unreadCount);
```

### Search Messages

```javascript
const { searchMessages } = require('./src/services/whatsapp');

// Search messages by content
const results = await searchMessages(
  tenantId,
  'invoice',
  50
);

console.log('Found', results.length, 'messages');
```

## 📚 API Reference

### WABAClient

The main client for interacting with Meta WhatsApp Business API.

#### Constructor
```javascript
new WABAClient(phoneNumberId, accessToken)
```

#### Methods

**Sending Messages:**
- `sendText(to, text)` - Send text message
- `sendImage(to, imageUrl, caption)` - Send image
- `sendVideo(to, videoUrl, caption)` - Send video
- `sendAudio(to, audioUrl)` - Send audio
- `sendDocument(to, documentUrl, filename, caption)` - Send document
- `sendReaction(to, messageId, emoji)` - Send reaction (or remove with empty emoji)

**Media Operations:**
- `getMediaInfo(mediaId)` - Get media metadata
- `downloadMedia(mediaId)` - Download to buffer
- `downloadMediaToFile(mediaId, outDir)` - Download to file
- `uploadMedia(filePath, mimeType)` - Upload to Meta
- `sendMediaById(to, mediaId, mediaType, caption)` - Send uploaded media

**Other:**
- `markAsRead(messageId)` - Mark message as read
- `formatPhone(phone)` - Format phone number
- `static verifyWebhook(mode, token, challenge, verifyToken)` - Verify webhook

### Message Handler

Functions for processing and managing messages.

- `parseIncomingMessage(webhookData)` - Parse webhook message
- `parseMessageStatus(webhookData)` - Parse status update
- `saveIncomingMessage(parsedMessage, accountId, tenantId)` - Save to DB
- `updateMessageStatus(statusUpdate)` - Update status in DB
- `getChatHistory(contactId, limit)` - Get chat history
- `getUnreadCount(contactId)` - Get unread count
- `markMessagesAsRead(contactId)` - Mark as read
- `searchMessages(tenantId, query, limit)` - Search messages

### Media Handler

Functions for media validation and processing.

**Constants:**
- `MEDIA_TYPES` - { IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER, VOICE }
- `MAX_FILE_SIZES` - Maximum file sizes for each type
- `SUPPORTED_MIME_TYPES` - Supported MIME types

**Functions:**
- `validateMedia(filePath, mediaType)` - Validate file
- `optimizeImage(inputPath, outputPath, options)` - Optimize image
- `createThumbnail(inputPath, outputPath, size)` - Create thumbnail
- `saveMediaBuffer(buffer, outputDir, filename)` - Save buffer to file
- `getMediaInfo(filePath)` - Get file info
- `mediaToDataURL(filePath)` - Convert to data URL
- `cleanupOldMedia(directory, maxAgeMs)` - Clean old files
- `getExtensionFromMimeType(mimeType)` - Get extension

## 🎯 Supported Message Types

- ✅ Text messages
- ✅ Image messages (JPEG, PNG)
- ✅ Video messages (MP4, 3GP)
- ✅ Audio messages (AAC, MP3, OGG, AMR)
- ✅ Document messages (PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX)
- ✅ Voice messages
- ✅ Sticker messages (WebP)
- ✅ Location messages
- ✅ Contact messages
- ✅ Reaction messages

## 📏 File Size Limits

- Images: 5 MB
- Videos: 16 MB
- Audio: 16 MB
- Documents: 100 MB
- Stickers: 500 KB

## 🔧 Configuration

The WABA client requires:
- **Phone Number ID**: From Meta Business Manager
- **Access Token**: From Meta Business Manager

These are typically stored in the `accounts` table in the database.

## 🧪 Testing

```javascript
// Test sending a message
const client = createWABAClient(
  process.env.WABA_PHONE_NUMBER_ID,
  process.env.WABA_ACCESS_TOKEN
);

await client.sendText('77001234567', 'Test message');
```

## 📝 Notes

- All phone numbers are automatically formatted (removes +, @s.whatsapp.net, non-digits)
- Media downloads require authorization (handled automatically)
- Image optimization uses Sharp library
- Messages are automatically saved with contact creation
- Status updates (sent, delivered, read) are tracked

## 🔗 Related Documentation

- [Meta WhatsApp Business API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Sharp Image Processing](https://sharp.pixelplumbing.com/)

---

**Last Updated:** February 6, 2026
