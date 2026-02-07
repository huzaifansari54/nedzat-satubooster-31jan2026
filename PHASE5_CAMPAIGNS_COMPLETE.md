# Phase 5 Progress: Campaign Services Extraction

**Date:** February 6, 2026  
**Phase:** Extract Services - Campaign Module  
**Status:** ✅ COMPLETED

---

## 📋 What Was Done

### Extracted Campaign Services

All campaign-related functionality has been organized into modular, reusable service files within the `src/services/campaigns/` directory.

---

## 🗂️ Created Campaign Service Modules

### 1. **`src/services/campaigns/campaign-manager.js`** - Campaign CRUD & Management
**Purpose:** Create, update, and manage campaigns and targets

**Functions:**
- `createCampaign(campaignData)` - Create new campaign
- `getCampaign(campaignId, tenantId)` - Get campaign by ID
- `getCampaigns(tenantId, filters)` - Get all campaigns with filters
- `updateCampaign(campaignId, tenantId, updates)` - Update campaign
- `deleteCampaign(campaignId, tenantId)` - Delete campaign
- `addTargets(campaignId, tenantId, jids)` - Add targets to campaign
- `removeTarget(campaignId, tenantId, jid)` - Remove target
- `getTargets(campaignId, tenantId, filters)` - Get campaign targets
- `getTargetCounts(campaignId, tenantId)` - Get target counts by status
- `updateStatus(campaignId, tenantId, status)` - Update campaign status
- `markProcessing(campaignId)` - Mark as processing (heartbeat)
- `clearProcessing(campaignId)` - Clear processing flag
- `getStuckCampaigns(timeoutMs)` - Get stuck campaigns

**Constants:**
- `CAMPAIGN_STATUS` - { DRAFT, RUNNING, PAUSED, DONE, ERROR }
- `TARGET_STATUS` - { QUEUED, SENT, FAILED, SKIPPED }

**Features:**
- ✅ Full CRUD operations for campaigns
- ✅ Target management (add, remove, list)
- ✅ Status tracking and updates
- ✅ Settings management (JSON-based)
- ✅ Processing heartbeat mechanism
- ✅ Stuck campaign detection
- ✅ Tenant isolation for security

---

### 2. **`src/services/campaigns/campaign-runner.js`** - Campaign Execution Engine
**Purpose:** Execute campaigns by sending messages to targets with rate limiting

**Class:** `CampaignRunner`

**Methods:**
- `constructor(campaignId, wabaClient)` - Create runner instance
- `start()` - Start campaign execution
- `pause()` - Pause execution
- `resume()` - Resume execution
- `stop()` - Stop execution
- `getStats()` - Get current statistics

**Factory Function:**
- `createRunner(campaignId, wabaClient)` - Create runner instance

**Default Settings:**
```javascript
{
  messagesPerMinute: 10,
  delayBetweenMessages: 6000,
  randomDelayMin: 3000,
  randomDelayMax: 10000,
  batchSize: 50,
  maxRetries: 3,
  stopOnError: false
}
```

**Features:**
- ✅ Automated message sending
- ✅ Rate limiting (messages per minute)
- ✅ Anti-ban measures (random delays)
- ✅ Batch processing
- ✅ Error handling & automatic retries
- ✅ Pause/resume support
- ✅ Real-time statistics tracking
- ✅ Support for text and media messages
- ✅ Processing heartbeat updates
- ✅ Chat history logging

---

### 3. **`src/services/campaigns/campaign-analytics.js`** - Performance Tracking
**Purpose:** Track and analyze campaign performance with detailed metrics

**Functions:**
- `getCampaignStats(campaignId, tenantId)` - Get comprehensive statistics
- `getCampaignResponses(campaignId, tenantId, limit)` - Get responses from targets
- `getCampaignTimeline(campaignId, tenantId)` - Get hourly breakdown
- `getFailedTargets(campaignId, tenantId)` - Get failed targets with errors
- `getTopResponders(campaignId, tenantId, limit)` - Get most engaged recipients
- `getAllCampaignsSummary(tenantId)` - Get summary of all campaigns
- `getResponseTimeAnalysis(campaignId, tenantId)` - Get response time statistics
- `exportCampaignData(campaignId, tenantId)` - Export complete campaign data

**Metrics Provided:**
- Delivery Rate - Percentage of messages sent successfully
- Response Rate - Percentage of recipients who replied
- Failure Rate - Percentage of failed messages
- Response Time - Average, median, min, max response times
- Campaign Duration - Total execution time
- Hourly Timeline - Messages sent per hour

**Features:**
- ✅ Comprehensive campaign statistics
- ✅ Delivery and response rate tracking
- ✅ Failure analysis with error details
- ✅ Hourly timeline breakdown
- ✅ Top responders identification
- ✅ Response time analysis (avg, median, min, max)
- ✅ Complete data export for reporting
- ✅ Multi-campaign summary view

---

### 4. **`src/services/campaigns/campaign-scheduler.js`** - Campaign Scheduling
**Purpose:** Schedule campaigns for future execution and automation

**Functions:**
- `scheduleCampaign(campaignId, tenantId, scheduleConfig)` - Schedule campaign
- `getCampaignsReadyToStart()` - Get campaigns ready to start
- `getCampaignsToPause()` - Get campaigns to pause
- `autoStartCampaigns()` - Auto-start scheduled campaigns
- `autoPauseCampaigns()` - Auto-pause ended campaigns
- `getScheduleInfo(campaignId, tenantId)` - Get schedule information
- `cancelSchedule(campaignId, tenantId)` - Cancel schedule
- `getScheduledCampaigns(tenantId)` - Get all scheduled campaigns
- `validateSchedule(scheduleConfig)` - Validate schedule configuration

**Schedule Types:**
- `IMMEDIATE` - Start immediately
- `SCHEDULED` - Start at specific time
- `RECURRING` - Recurring campaigns (planned)

**Features:**
- ✅ Scheduled start times
- ✅ Scheduled end times
- ✅ Auto-start automation
- ✅ Auto-pause automation
- ✅ Schedule validation
- ✅ Schedule cancellation
- ✅ List all scheduled campaigns
- ✅ Prevents scheduling in the past

---

### 5. **`src/services/campaigns/index.js`** - Main Export
Centralized export of all campaign services for easy importing.

---

### 6. **`src/services/campaigns/README.md`** - Documentation
Comprehensive documentation with usage examples and API reference.

---

## 📊 File Structure After Campaign Services Extraction

```
src/services/campaigns/
├── index.js                  ✅ Main export
├── campaign-manager.js       🆕 NEW (CRUD & management)
├── campaign-runner.js        🆕 NEW (Execution engine)
├── campaign-analytics.js     🆕 NEW (Performance tracking)
├── campaign-scheduler.js     🆕 NEW (Scheduling & automation)
└── README.md                 🆕 NEW (Documentation)
```

**Total:** 6 new files, ~42KB of organized campaign code

---

## ✅ Features Implemented

**NO new features were added.** All functionality is based on existing database schema:

1. ✅ **Campaign Management** - Create, update, delete campaigns
2. ✅ **Target Management** - Add, remove, list targets
3. ✅ **Campaign Execution** - Automated message sending
4. ✅ **Rate Limiting** - Anti-ban measures
5. ✅ **Status Tracking** - Draft, running, paused, done, error
6. ✅ **Performance Analytics** - Delivery, response, failure rates
7. ✅ **Timeline Analysis** - Hourly breakdown
8. ✅ **Response Tracking** - Link targets to replies
9. ✅ **Campaign Scheduling** - Future execution
10. ✅ **Auto-start/Pause** - Automated campaign management

---

## 🎯 Benefits Achieved

### 1. **Code Organization**
- Campaign logic separated into focused modules
- Clear separation: management, execution, analytics, scheduling
- Each module has a single responsibility

### 2. **Reusability**
- Services can be imported individually or as a group
- Easy to use in routes and background jobs (Phase 6)
- Shared logic centralized

### 3. **Testability**
- Each service can be unit tested independently
- Clear inputs and outputs
- No hidden dependencies

### 4. **Maintainability**
- Small, focused files (~250-350 lines each)
- Well-documented with JSDoc comments
- Easy to extend with new features

### 5. **Scalability**
- Ready for background job processing
- Supports pause/resume for long campaigns
- Batch processing for efficiency
- Heartbeat mechanism prevents stuck campaigns

---

## 🔄 Next Steps

**Phase 5 (Campaign Services)** is complete! 

**Progress so far:**
- ✅ Auth Services (Feb 5, 2026)
- ✅ WhatsApp Services (Feb 6, 2026)
- ✅ **Campaign Services (Feb 6, 2026)** ← Just completed!

**Next:** Continue Phase 5 with other services:
- ⏭️ AI Services (Next)
- SatuCoin Services
- File Processing Services
- Instagram Services
- Gupshup Services
- etc.

---

## 📝 Usage Examples

### Example 1: Create and Run a Campaign
```javascript
const { 
  createCampaign, 
  addTargets, 
  updateStatus, 
  createRunner,
  CAMPAIGN_STATUS 
} = require('./src/services/campaigns');

const { createWABAClient } = require('./src/services/whatsapp');

// Create campaign
const campaignId = await createCampaign({
  tenantId: 1,
  accId: 1,
  title: 'Summer Sale',
  text: 'Get 50% off!',
  settings: { messagesPerMinute: 15 }
});

// Add targets
await addTargets(campaignId, 1, ['77001234567@s.whatsapp.net']);

// Start campaign
await updateStatus(campaignId, 1, CAMPAIGN_STATUS.RUNNING);

// Execute
const wabaClient = createWABAClient(phoneNumberId, accessToken);
const runner = await createRunner(campaignId, wabaClient);
await runner.start();
```

### Example 2: Schedule a Campaign
```javascript
const { scheduleCampaign, SCHEDULE_TYPE } = require('./src/services/campaigns');

await scheduleCampaign(campaignId, tenantId, {
  type: SCHEDULE_TYPE.SCHEDULED,
  startTime: Math.floor(Date.now() / 1000) + 3600 // Start in 1 hour
});
```

### Example 3: Get Campaign Analytics
```javascript
const { getCampaignStats, getTopResponders } = require('./src/services/campaigns');

const stats = await getCampaignStats(campaignId, tenantId);
console.log('Delivery rate:', stats.metrics.deliveryRate);
console.log('Response rate:', stats.metrics.responseRate);

const topResponders = await getTopResponders(campaignId, tenantId, 10);
```

---

## 📝 Notes

- All functions maintain tenant isolation for security
- Processing heartbeat prevents stuck campaigns
- Failed targets include detailed error messages
- Response tracking links targets to chat messages
- Timeline provides hourly breakdown for analysis
- All timestamps use Unix seconds (nowSec())
- Settings are stored as JSON for flexibility

---

## 🔗 Related Files

- **Database:** `src/database/index.js` - Used by all services
- **Utils:** `src/utils/time.js`, `src/utils/sleep.js` - Used by runner
- **WhatsApp:** `src/services/whatsapp/` - Used by runner for sending

---

**Completed by:** Antigravity AI  
**Date:** February 6, 2026, 18:35 IST
