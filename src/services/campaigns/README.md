# Campaign Services

This module provides comprehensive campaign management for the NeDzat CRM platform, including creation, execution, scheduling, and analytics.

## 📁 Structure

```
src/services/campaigns/
├── index.js                  # Main export - import from here
├── campaign-manager.js       # Campaign CRUD operations
├── campaign-runner.js        # Campaign execution engine
├── campaign-analytics.js     # Performance tracking & reporting
└── campaign-scheduler.js     # Campaign scheduling & automation
```

## 🚀 Quick Start

### Import Services

```javascript
// Import everything
const campaigns = require('./src/services/campaigns');

// Or import specific services
const { 
  createCampaign, 
  CampaignRunner, 
  getCampaignStats 
} = require('./src/services/campaigns');
```

### Create a Campaign

```javascript
const { createCampaign, addTargets } = require('./src/services/campaigns');

// Create campaign
const campaignId = await createCampaign({
  tenantId: 1,
  accId: 1,
  title: 'Summer Sale 2026',
  text: 'Get 50% off on all products! Limited time offer.',
  mediaFile: 'uploads/summer-sale.jpg',
  mediaKind: 'image',
  settings: {
    messagesPerMinute: 10,
    delayBetweenMessages: 6000,
    randomDelayMin: 3000,
    randomDelayMax: 10000
  }
});

// Add targets
const targets = [
  '77001234567@s.whatsapp.net',
  '77007654321@s.whatsapp.net'
];

await addTargets(campaignId, tenantId, targets);
```

### Run a Campaign

```javascript
const { createRunner, updateStatus, CAMPAIGN_STATUS } = require('./src/services/campaigns');
const { createWABAClient } = require('./src/services/whatsapp');

// Update status to running
await updateStatus(campaignId, tenantId, CAMPAIGN_STATUS.RUNNING);

// Create WABA client
const wabaClient = createWABAClient(phoneNumberId, accessToken);

// Create and start runner
const runner = await createRunner(campaignId, wabaClient);

runner.start()
  .then(stats => {
    console.log('Campaign completed:', stats);
  })
  .catch(error => {
    console.error('Campaign failed:', error);
  });

// Pause campaign
runner.pause();

// Resume campaign
runner.resume();

// Stop campaign
runner.stop();
```

### Schedule a Campaign

```javascript
const { 
  scheduleCampaign, 
  SCHEDULE_TYPE 
} = require('./src/services/campaigns');

// Schedule for specific time
await scheduleCampaign(campaignId, tenantId, {
  type: SCHEDULE_TYPE.SCHEDULED,
  startTime: Math.floor(Date.now() / 1000) + 3600, // Start in 1 hour
  endTime: Math.floor(Date.now() / 1000) + 7200    // End in 2 hours
});

// Auto-start scheduled campaigns (call this periodically)
const { autoStartCampaigns } = require('./src/services/campaigns');
setInterval(async () => {
  const started = await autoStartCampaigns();
  console.log('Auto-started campaigns:', started);
}, 60000); // Every minute
```

### Get Campaign Analytics

```javascript
const { 
  getCampaignStats,
  getCampaignTimeline,
  getTopResponders 
} = require('./src/services/campaigns');

// Get overall stats
const stats = await getCampaignStats(campaignId, tenantId);
console.log('Delivery rate:', stats.metrics.deliveryRate);
console.log('Response rate:', stats.metrics.responseRate);

// Get hourly timeline
const timeline = await getCampaignTimeline(campaignId, tenantId);

// Get top responders
const topResponders = await getTopResponders(campaignId, tenantId, 10);
```

## 📚 API Reference

### Campaign Manager

**Campaign CRUD:**
- `createCampaign(campaignData)` - Create new campaign
- `getCampaign(campaignId, tenantId)` - Get campaign by ID
- `getCampaigns(tenantId, filters)` - Get all campaigns
- `updateCampaign(campaignId, tenantId, updates)` - Update campaign
- `deleteCampaign(campaignId, tenantId)` - Delete campaign

**Target Management:**
- `addTargets(campaignId, tenantId, jids)` - Add targets
- `removeTarget(campaignId, tenantId, jid)` - Remove target
- `getTargets(campaignId, tenantId, filters)` - Get targets
- `getTargetCounts(campaignId, tenantId)` - Get target counts by status

**Status Management:**
- `updateStatus(campaignId, tenantId, status)` - Update campaign status
- `markProcessing(campaignId)` - Mark as processing (heartbeat)
- `clearProcessing(campaignId)` - Clear processing flag
- `getStuckCampaigns(timeoutMs)` - Get stuck campaigns

**Constants:**
- `CAMPAIGN_STATUS` - { DRAFT, RUNNING, PAUSED, DONE, ERROR }
- `TARGET_STATUS` - { QUEUED, SENT, FAILED, SKIPPED }

### Campaign Runner

**Class: CampaignRunner**
- `constructor(campaignId, wabaClient)` - Create runner instance
- `start()` - Start campaign execution
- `pause()` - Pause execution
- `resume()` - Resume execution
- `stop()` - Stop execution
- `getStats()` - Get current statistics

**Factory:**
- `createRunner(campaignId, wabaClient)` - Create runner instance

**Settings:**
- `DEFAULT_SETTINGS` - Default campaign execution settings

### Campaign Analytics

**Statistics:**
- `getCampaignStats(campaignId, tenantId)` - Get comprehensive stats
- `getCampaignResponses(campaignId, tenantId, limit)` - Get responses
- `getCampaignTimeline(campaignId, tenantId)` - Get hourly breakdown
- `getFailedTargets(campaignId, tenantId)` - Get failed targets
- `getTopResponders(campaignId, tenantId, limit)` - Get top responders
- `getAllCampaignsSummary(tenantId)` - Get all campaigns summary
- `getResponseTimeAnalysis(campaignId, tenantId)` - Get response time stats
- `exportCampaignData(campaignId, tenantId)` - Export complete data

### Campaign Scheduler

**Scheduling:**
- `scheduleCampaign(campaignId, tenantId, scheduleConfig)` - Schedule campaign
- `cancelSchedule(campaignId, tenantId)` - Cancel schedule
- `getScheduleInfo(campaignId, tenantId)` - Get schedule info
- `getScheduledCampaigns(tenantId)` - Get all scheduled campaigns

**Automation:**
- `autoStartCampaigns()` - Auto-start ready campaigns
- `autoPauseCampaigns()` - Auto-pause ended campaigns
- `getCampaignsReadyToStart()` - Get campaigns ready to start
- `getCampaignsToPause()` - Get campaigns to pause

**Validation:**
- `validateSchedule(scheduleConfig)` - Validate schedule configuration

**Constants:**
- `SCHEDULE_TYPE` - { IMMEDIATE, SCHEDULED, RECURRING }

## 🎯 Features

### Campaign Manager
- ✅ Full CRUD operations
- ✅ Target management (add, remove, list)
- ✅ Status tracking (draft, running, paused, done, error)
- ✅ Settings management (JSON-based)
- ✅ Processing heartbeat
- ✅ Stuck campaign detection

### Campaign Runner
- ✅ Automated message sending
- ✅ Rate limiting (messages per minute)
- ✅ Anti-ban measures (random delays)
- ✅ Batch processing
- ✅ Error handling & retries
- ✅ Pause/resume support
- ✅ Real-time statistics
- ✅ Support for text and media messages

### Campaign Analytics
- ✅ Delivery rate tracking
- ✅ Response rate analysis
- ✅ Failure rate monitoring
- ✅ Hourly timeline breakdown
- ✅ Top responders identification
- ✅ Response time analysis
- ✅ Failed targets reporting
- ✅ Complete data export

### Campaign Scheduler
- ✅ Scheduled start times
- ✅ Scheduled end times
- ✅ Auto-start automation
- ✅ Auto-pause automation
- ✅ Schedule validation
- ✅ Recurring campaigns (planned)

## ⚙️ Default Settings

```javascript
{
  messagesPerMinute: 10,        // Rate limit
  delayBetweenMessages: 6000,   // 6 seconds
  randomDelayMin: 3000,         // Min random delay (3s)
  randomDelayMax: 10000,        // Max random delay (10s)
  batchSize: 50,                // Process in batches
  maxRetries: 3,                // Max retry attempts
  stopOnError: false            // Continue on errors
}
```

## 📊 Campaign Statuses

- **draft** - Campaign created but not started
- **running** - Campaign is actively sending messages
- **paused** - Campaign temporarily stopped
- **done** - Campaign completed successfully
- **error** - Campaign stopped due to error

## 📋 Target Statuses

- **queued** - Target waiting to receive message
- **sent** - Message sent successfully
- **failed** - Message failed to send
- **skipped** - Target skipped (e.g., blocked)

## 🔧 Anti-Ban Measures

The campaign runner includes several anti-ban features:

1. **Rate Limiting** - Configurable messages per minute
2. **Random Delays** - Random delays between messages
3. **Fixed Delays** - Minimum delay between messages
4. **Batch Processing** - Process targets in batches
5. **Retry Logic** - Automatic retries on failure
6. **Heartbeat** - Processing status updates

## 📈 Analytics Metrics

- **Delivery Rate** - Percentage of messages sent successfully
- **Response Rate** - Percentage of recipients who replied
- **Failure Rate** - Percentage of failed messages
- **Response Time** - Average time to first response
- **Top Responders** - Most engaged recipients

## 🧪 Example: Complete Campaign Flow

```javascript
const { 
  createCampaign, 
  addTargets, 
  updateStatus,
  createRunner,
  getCampaignStats,
  CAMPAIGN_STATUS 
} = require('./src/services/campaigns');

const { createWABAClient } = require('./src/services/whatsapp');

// 1. Create campaign
const campaignId = await createCampaign({
  tenantId: 1,
  accId: 1,
  title: 'Product Launch',
  text: 'Check out our new product!',
  settings: {
    messagesPerMinute: 15,
    randomDelayMin: 2000,
    randomDelayMax: 8000
  }
});

// 2. Add targets
await addTargets(campaignId, 1, [
  '77001234567@s.whatsapp.net',
  '77007654321@s.whatsapp.net'
]);

// 3. Start campaign
await updateStatus(campaignId, 1, CAMPAIGN_STATUS.RUNNING);

// 4. Execute campaign
const wabaClient = createWABAClient(phoneNumberId, accessToken);
const runner = await createRunner(campaignId, wabaClient);

const stats = await runner.start();
console.log('Campaign completed:', stats);

// 5. Get analytics
const analytics = await getCampaignStats(campaignId, 1);
console.log('Delivery rate:', analytics.metrics.deliveryRate);
console.log('Response rate:', analytics.metrics.responseRate);
```

## 📝 Notes

- Campaigns are tenant-isolated for security
- Processing heartbeat prevents stuck campaigns
- Failed targets include error details
- Response tracking links targets to chat messages
- Timeline provides hourly breakdown
- All timestamps are in Unix seconds

## 🔗 Related Services

- **WhatsApp Services** - For sending messages
- **Database** - For data persistence
- **Utils** - For time and sleep utilities

---

**Last Updated:** February 6, 2026
