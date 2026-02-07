# Instagram Service

Instagram integration service for NeDzat SaaS platform, built on Meta's Instagram Graph API.

## 📁 Structure

```
src/services/instagram/
├── index.js          # Main service export
├── api-client.js     # Instagram Graph API client
└── webhook.js        # Webhook processing and handlers
```

## 🚀 Quick Start

### 1. Environment Setup

Add these variables to your `.env` file:

```env
IG_APP_ID=your_instagram_app_id
IG_APP_SECRET=your_instagram_app_secret
IG_VERIFY_TOKEN=your_webhook_verify_token
PUBLIC_BASE_URL=https://yourdomain.com
```

### 2. Import the Service

```javascript
const instagramService = require('./src/services/instagram');
```

## 📚 API Client Usage

### Send a Direct Message

```javascript
const { InstagramAPIClient } = require('./src/services/instagram');

const client = new InstagramAPIClient(accessToken);

await client.sendDirectMessage(
  recipientId,  // Instagram-scoped user ID
  'Hello! How can I help you today?'
);
```

### Reply to a Comment

```javascript
await client.replyToComment(
  commentId,
  'Thank you for your comment!'
);
```

### Reply to a Story Mention

```javascript
await client.replyToStory(
  storyId,
  'Thanks for mentioning us!'
);
```

### Get User Profile

```javascript
const profile = await client.getUserProfile(
  userId,
  ['id', 'username', 'name', 'profile_picture_url']
);
```

### Exchange Token (Short-lived → Long-lived)

```javascript
const tokenData = await InstagramAPIClient.exchangeToken(
  shortLivedToken,
  appId,
  appSecret
);

// tokenData.access_token - long-lived token (60 days)
// tokenData.expires_in - expiration time in seconds
```

### Refresh Long-lived Token

```javascript
const refreshed = await InstagramAPIClient.refreshToken(longLivedToken);
```

## 🔔 Webhook Handling

### Verify Webhook (GET Request)

```javascript
const { handleWebhookVerification } = require('./src/services/instagram');

app.get('/api/webhooks/instagram', (req, res) => {
  const result = handleWebhookVerification(req.query, IG_VERIFY_TOKEN);
  
  if (result.verified) {
    res.status(200).send(result.challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});
```

### Process Webhook Events (POST Request)

```javascript
const { 
  verifyWebhookSignature, 
  processWebhookPayload 
} = require('./src/services/instagram');

app.post('/api/webhooks/instagram', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody; // Raw request body as string
  
  // Verify signature
  if (!verifyWebhookSignature(rawBody, signature, IG_APP_SECRET)) {
    return res.status(403).send('Invalid signature');
  }
  
  // Process events
  const events = await processWebhookPayload(req.body);
  
  // Handle events (emit to Socket.IO, trigger AI responses, etc.)
  for (const event of events) {
    console.log('Instagram event:', event.type, event);
    // Your custom logic here
  }
  
  res.status(200).send('OK');
});
```

## 💾 Database Operations

### Save Incoming Message

```javascript
const { saveIncomingMessage } = require('./src/services/instagram');

await saveIncomingMessage({
  tenantId: 1,
  threadId: 'thread_123',
  fromId: 'user_456',
  text: 'Hello!',
  rawJson: { /* full webhook payload */ }
});
```

### Save Outgoing Message

```javascript
const { saveOutgoingMessage } = require('./src/services/instagram');

await saveOutgoingMessage({
  tenantId: 1,
  threadId: 'thread_123',
  text: 'Hi! How can I help?',
  rawJson: { /* API response */ }
});
```

### Log Instagram Action

```javascript
const { logInstagramAction } = require('./src/services/instagram');

await logInstagramAction({
  tenantId: 1,
  userId: 5,
  channel: 'dm',
  targetId: 'thread_123',
  incomingText: 'User question',
  aiText: 'AI response',
  coinSpent: 30,
  status: 'ok',
  latencyMs: 1250
});
```

## ⚙️ Settings & Connections

### Get Instagram Connection

```javascript
const { getInstagramConnection } = require('./src/services/instagram');

const connection = await getInstagramConnection(tenantId);

if (connection) {
  console.log('Connected:', connection.username);
  console.log('Access Token:', connection.access_token);
  console.log('Expires:', new Date(connection.token_expires_at * 1000));
}
```

### Get Instagram Settings

```javascript
const { getInstagramSettings } = require('./src/services/instagram');

const settings = await getInstagramSettings(tenantId);

console.log('DMs enabled:', settings.dm_enabled);
console.log('Comments enabled:', settings.comments_enabled);
console.log('AI enabled:', settings.ai_enabled);
```

## 🧹 Maintenance

### Clean Up Old Deduplication Records

```javascript
const { cleanupDedupRecords } = require('./src/services/instagram');

// Run periodically (e.g., every hour)
setInterval(async () => {
  await cleanupDedupRecords();
}, 60 * 60 * 1000);
```

## 🔒 Security

### Webhook Signature Verification

All webhook payloads are verified using HMAC-SHA256:

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, appSecret) {
  const expectedSignature = signature.split('sha256=')[1];
  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(payload, 'utf8');
  const calculatedSignature = hmac.digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(calculatedSignature, 'hex')
  );
}
```

### Deduplication

Instagram webhooks may send duplicate events. The service automatically deduplicates based on:
- **DMs:** `dm:{threadId}:{timestamp}`
- **Comments:** `comment:{commentId}`
- **Mentions:** `mention:{mentionId}`

Records are kept for 5 minutes and cleaned up after 1 hour.

## 📊 Event Types

The webhook handler processes these event types:

| Event Type | Channel | Description |
|------------|---------|-------------|
| `direct_message` | DM | Incoming direct message |
| `comment` | Comment | Comment on a post |
| `story_mention` | Mention | User mentioned you in a story |

## 🗄️ Database Schema

### Tables Used

- **ig_connections** - Instagram account connections
- **ig_chats** - Message history
- **ig_chat_state** - Active conversation states
- **ig_webhook_dedup** - Deduplication tracking
- **ig_events** - Event logging
- **ig_actions** - Action analytics
- **ig_settings** - Tenant settings

## 🔗 Integration Example

Complete example with AI auto-reply:

```javascript
const express = require('express');
const instagramService = require('./src/services/instagram');
const aiService = require('./src/services/ai');

const app = express();

// Webhook endpoint
app.post('/api/webhooks/instagram', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  
  if (!instagramService.verifyWebhookSignature(req.rawBody, signature, process.env.IG_APP_SECRET)) {
    return res.status(403).send('Invalid signature');
  }
  
  const events = await instagramService.processWebhookPayload(req.body);
  
  for (const event of events) {
    if (event.type === 'direct_message') {
      // Get connection and settings
      const connection = await instagramService.getInstagramConnection(event.tenantId);
      const settings = await instagramService.getInstagramSettings(event.tenantId);
      
      if (settings.ai_enabled && connection) {
        // Generate AI response
        const aiResponse = await aiService.generateResponse({
          tenantId: event.tenantId,
          message: event.text,
          context: 'instagram_dm'
        });
        
        // Send reply
        const client = new instagramService.InstagramAPIClient(connection.access_token);
        await client.sendDirectMessage(event.fromId, aiResponse);
        
        // Save outgoing message
        await instagramService.saveOutgoingMessage({
          tenantId: event.tenantId,
          threadId: event.threadId,
          text: aiResponse
        });
        
        // Log action
        await instagramService.logInstagramAction({
          tenantId: event.tenantId,
          channel: 'dm',
          targetId: event.threadId,
          incomingText: event.text,
          aiText: aiResponse,
          status: 'ok'
        });
      }
    }
  }
  
  res.status(200).send('OK');
});
```

## 📖 References

- [Instagram Graph API](https://developers.facebook.com/docs/instagram-api)
- [Instagram Messaging API](https://developers.facebook.com/docs/messenger-platform/instagram)
- [Webhooks Guide](https://developers.facebook.com/docs/graph-api/webhooks)

## 🐛 Troubleshooting

### Webhook Not Receiving Events

1. Check that webhook is subscribed in Meta App Dashboard
2. Verify `IG_VERIFY_TOKEN` matches the one in Meta App Dashboard
3. Ensure webhook URL is publicly accessible (HTTPS required)
4. Check signature verification is working

### Token Expired

Long-lived tokens expire after 60 days. Refresh them before expiration:

```javascript
const connection = await getInstagramConnection(tenantId);
const expiresAt = connection.token_expires_at;
const now = Math.floor(Date.now() / 1000);

if (expiresAt - now < 7 * 24 * 3600) { // Less than 7 days
  const refreshed = await InstagramAPIClient.refreshToken(connection.access_token);
  // Update database with new token
}
```

### Messages Not Sending

1. Verify access token is valid
2. Check recipient ID is correct (Instagram-scoped ID)
3. Ensure user has messaged you first (24-hour window)
4. Check rate limits

---

**Last Updated:** February 7, 2026  
**Status:** Production Ready ✅
