# AI Routes Implementation - Complete

**Date:** February 12, 2026  
**Phase:** Phase 6 - Create Routes

## Summary

Successfully implemented the `ai.routes.js` module, extracting AI/LLM usage tracking and analytics endpoints from the monolithic `index.js` file. This module provides comprehensive insights into AI model usage, token consumption, costs, and performance across the platform.

## Files Created

### 1. `src/routes/ai.routes.js`
- **Lines:** 337
- **Purpose:** AI usage analytics, cost tracking, and model statistics

## Endpoints Implemented

### 1. **GET /api/ai/summary**
- **Migrated from:** `index.js` line 5150 (`GET /api/admin/ai/summary`)
- **Description:** Get AI usage summary with token and cost breakdown
- **Access:** Admin only
- **Query Parameters:**
  - `range` - Time range (1h, 24h, 7d, 30d - default: 7d)
- **Returns:**
  - `totals` - Aggregated stats (messages, tokens, costs)
  - `by_model` - Breakdown by AI model
- **Features:**
  - Flexible time ranges
  - Comprehensive cost tracking (in, out, total)
  - Model-wise breakdown ordered by cost

### 2. **GET /api/ai/messages**
- **Migrated from:** `index.js` line 5202 (`GET /api/admin/users/ai_messages`)
- **Description:** Get AI message details for a specific user
- **Access:** Admin only
- **Query Parameters:**
  - `user_id` (required) - User ID to query
  - `range` - Time range (default: 7d)
  - `q` - Search query (filter by message content)
  - `limit` - Result limit (20-300, default: 120)
- **Returns:**
  - Array of message records with model, tokens, and cost info
- **Features:**
  - User-specific message tracking
  - Full-text search capability
  - Pagination support

### 3. **GET /api/ai/costs**
- **Status:** ⚠️ STUB IMPLEMENTATION
- **Original location:** `index.js` line 5626 (`GET /api/admin/openai/costs`)
- **Description:** Get OpenAI organization costs from API
- **Access:** Admin only
- **Returns:** HTTP 501 Not Implemented
- **Note:** Requires `openaiOrgGET` function that makes requests to OpenAI's organization API. Should be extracted into a service module first.

### 4. **GET /api/ai/models** (New)
- **Description:** Get list of AI models with usage statistics
- **Access:** Admin only
- **Query Parameters:**
  - `range` - Time range (default: 30d)
- **Returns:**
  - Array of models with detailed stats:
    - `message_count` - Total messages sent
    - `total_*_tokens` - Token usage breakdown
    - `total_cost` - Total cost in USD
    - `avg_tokens_per_message` - Average efficiency
    - `first_used` / `last_used` - Usage timeline
- **Features:**
  - Ranked by total cost
  - Comprehensive usage metrics
  - Efficiency analysis

### 5. **GET /api/ai/stats/tenant/:tenant_id** (New)
- **Description:** Get AI usage statistics for a specific tenant
- **Access:** Admin only
- **Path Parameters:**
  - `tenant_id` - Tenant ID
- **Query Parameters:**
  - `range` - Time range (default: 30d)
- **Returns:**
  - Aggregated tenant stats
  - Model breakdown
  - Resource usage (accounts, contacts, models)

### 6. **GET /api/ai/stats/account/:account_id** (New)
- **Description:** Get AI usage statistics for a specific account
- **Access:** Authenticated users (own account) or Admin
- **Path Parameters:**
  - `account_id` - Account ID
- **Query Parameters:**
  - `range` - Time range (default: 30d)
- **Returns:**
  - Account-specific stats
  - Message count, tokens, costs
  - Unique contacts served
- **Features:**
  - Ownership verification for non-admins
  - Cross-tenant protection

### 7. **GET /api/ai/usage/daily** (New)
- **Description:** Get daily AI usage breakdown for charting
- **Access:** Admin only
- **Query Parameters:**
  - `range` - Time range (default: 30d)
  - `tenant_id` (optional) - Filter by tenant
- **Returns:**
  - Daily breakdown with date, messages, tokens, cost
- **Features:**
  - Perfect for time-series charts
  - Optional tenant filtering
  - Ordered chronologically

## Integration

### Updated Files

1. **`src/routes/index.js`**
   - Added `aiRoutes` import
   - Mounted at `/ai` path
   - Routes now accessible at `/api/ai/*`

2. **`MIGRATION_CHECKLIST.md`**
   - Marked `ai.routes.js` as completed ✅
   - Updated completion date: Feb 12, 2026

## API Endpoints Summary

| Method | Path | Access | Status | Description |
|--------|------|--------|--------|-------------|
| GET | /api/ai/summary | Admin | ✅ Complete | Overall AI usage summary |
| GET | /api/ai/messages | Admin | ✅ Complete | User-specific AI messages |
| GET | /api/ai/costs | Admin | ⚠️ Stub | OpenAI org costs (use /api/admin/openai/costs) |
| GET | /api/ai/models | Admin | ✅ Complete | Model usage statistics |
| GET | /api/ai/stats/tenant/:tenant_id | Admin | ✅ Complete | Tenant AI stats |
| GET | /api/ai/stats/account/:account_id | Auth | ✅ Complete | Account AI stats |
| GET | /api/ai/usage/daily | Admin | ✅ Complete | Daily usage breakdown |

## Database Schema

The module queries the following table:
- `chats` - Message history with AI metadata
  - `type` - Direction (in/out)
  - `model` - AI model used (gpt-4, gpt-3.5-turbo, etc.)
  - `prompt_tokens` - Input tokens
  - `completion_tokens` - Output tokens
  - `total_tokens` - Sum of input + output
  - `cost_usd` - Total cost
  - `cost_usd_in` - Input cost
  - `cost_usd_out` - Output cost
  - `cost_usd_total` - Total cost (alternative field)

## Migration Notes

### Original Code Locations
- **Summary:** `index.js` line 5150-5200 (`GET /api/admin/ai/summary`)
- **Messages:** `index.js` line 5202-5236 (`GET /api/admin/users/ai_messages`)
- **Costs:** `index.js` line 5626-5642 (`GET /api/admin/openai/costs`) - NOT MIGRATED

### Changes from Original

1. **Endpoint paths:**
   - `/api/admin/ai/summary` → `/api/ai/summary`
   - `/api/admin/users/ai_messages` → `/api/ai/messages`
   - `/api/admin/openai/costs` → `/api/ai/costs` (stub only)

2. **New endpoints:**
   - GET `/api/ai/models` - Model comparison
   - GET `/api/ai/stats/tenant/:tenant_id` - Tenant analytics
   - GET `/api/ai/stats/account/:account_id` - Account analytics
   - GET `/api/ai/usage/daily` - Time-series data

3. **Improvements:**
   - Consistent response format
   - Type coercion for all numeric fields
   - Better error messages

### Backward Compatibility

⚠️ **Partial Breaking Changes:**
- Summary endpoint path changed
- Messages endpoint path changed
- Costs endpoint is a stub (use original for now)

**Migration Path for Frontend:**
```javascript
// AI Summary
// OLD: GET /api/admin/ai/summary?range=7d
// NEW: GET /api/ai/summary?range=7d

// User Messages
// OLD: GET /api/admin/users/ai_messages?user_id=1
// NEW: GET /api/ai/messages?user_id=1

// OpenAI Costs
// CURRENT: GET /api/admin/openai/costs (still in index.js)
// FUTURE: GET /api/ai/costs (to be implemented)
```

## Technical Implementation

### Time Range Helper

**`rangeToWindow(range)`** function:
- Converts human-readable ranges to Unix timestamps
- Supported ranges: 1h, 24h, 7d, 30d
- Returns `{ from, to, label }` for consistency

### Cost Tracking

The platform tracks multiple cost metrics:

1. **cost_usd** - Legacy total cost field
2. **cost_usd_in** - Input/prompt cost
3. **cost_usd_out** - Output/completion cost
4. **cost_usd_total** - Alternative total cost field

Different AI models may use different fields, so the summary aggregates all.

### Model Support

Common models tracked:
- `gpt-4` / `gpt-4-turbo` - OpenAI GPT-4
- `gpt-3.5-turbo` - OpenAI GPT-3.5
- `claude-*` - Anthropic Claude
- `gemini-*` - Google Gemini
- Custom models from other providers

## Testing Checklist

- [ ] Test GET /api/ai/summary with different ranges
- [ ] Test GET /api/ai/summary - verify model breakdown
- [ ] Test GET /api/ai/messages with valid user_id
- [ ] Test GET /api/ai/messages with search query
- [ ] Test GET /api/ai/messages with invalid user_id
- [ ] Test GET /api/ai/models - verify all models listed
- [ ] Test GET /api/ai/models - check cost ranking
- [ ] Test GET /api/ai/stats/tenant/:id for valid tenant
- [ ] Test GET /api/ai/stats/account/:id as account owner
- [ ] Test GET /api/ai/stats/account/:id as different user (should fail)
- [ ] Test GET /api/ai/stats/account/:id as admin (should work)
- [ ] Test GET /api/ai/usage/daily without tenant filter
- [ ] Test GET /api/ai/usage/daily with tenant filter
- [ ] Test GET /api/ai/costs - should return 501
- [ ] Verify all admin endpoints require adminOnly middleware
- [ ] Verify non-admin endpoints allow authenticated users
- [ ] Test cross-tenant access protection

## Important Limitations

### OpenAI Organization Costs Not Implemented

The `GET /api/ai/costs` endpoint is a **stub** that returns HTTP 501. Here's why:

**Complexity:** The original endpoint at index.js:5626 requires:
1. **openaiOrgGET Function:**
   - Makes authenticated requests to OpenAI's organization API
   - Endpoint: `https://api.openai.com/v1/organization/costs`
   - Requires organization API key (different from chat API key)
   
2. **Time Range Conversion:**
   - `rangeToStartEnd` helper (different from `rangeToWindow`)
   - Returns ISO date strings instead of Unix timestamps

3. **Dependencies:**
   - OpenAI organization API credentials
   - Proper error handling for API failures

**Recommended Approach:**
Extract into service module:
```javascript
// src/services/ai/openai-org.js
async function getOrganizationCosts(range) {
  const { start, end } = rangeToStartEnd(range);
  return await openaiOrgGET('/v1/organization/costs', {
    start_time: start,
    end_time: end,
    bucket_width: '1d'
  });
}
```

**For now, continue using `/api/admin/openai/costs` for organization costs.**

## Use Cases

### 1. **Cost Monitoring Dashboard**
```javascript
// Get overall summary
const summary = await fetch('/api/ai/summary?range=30d');

// Get daily breakdown for chart
const daily = await fetch('/api/ai/usage/daily?range=30d');

// Get model comparison
const models = await fetch('/api/ai/models?range=30d');
```

### 2. **User Usage Analysis**
```javascript
// Admin viewing specific user's AI usage
const messages = await fetch('/api/ai/messages?user_id=123&range=7d');
```

### 3. **Tenant Billing**
```javascript
// Calculate tenant's AI costs
const stats = await fetch('/api/ai/stats/tenant/456?range=30d');
const { total_cost, message_count } = stats.stats;
```

### 4. **Account Performance**
```javascript
// Account owner checking their AI usage
const accountStats = await fetch('/api/ai/stats/account/789?range=7d');
```

## Performance Considerations

1. **Summary Endpoint:**
   - Aggregates across entire chats table
   - Uses indexes on (type, total_tokens, ts)
   - Model grouping adds overhead

2. **Messages Endpoint:**
   - Limited to 300 results max
   - Full-text search on message column may be slow
   - Consider adding FTS index for production

3. **Models Endpoint:**
   - Smaller result set (typically <10 models)
   - Multiple aggregations per model
   - Fast enough for admin dashboards

4. **Daily Usage:**
   - Pre-grouped by date column
   - Small result set (max 30-90 rows typically)
   - Perfect for caching

## Future Enhancements

1. **Cost Alerts:** Email/notify when costs exceed threshold
2. **Budget Limits:** Automatically disable AI when budget reached
3. **Model Recommendations:** Suggest cheaper models for similar tasks
4. **Token Optimization:** Identify conversations with excessive token usage
5. **A/B Testing:** Compare performance of different models
6. **Caching:** Cache daily aggregations for faster queries
7. **Export:** Download usage reports as CSV/PDF
8. **Real-time Costs:** WebSocket updates for live cost tracking
9. **Cost Predictions:** ML-based forecasting of monthly costs
10. **Complete OpenAI Org Integration:** Full organization API support

## Code Quality

- ✅ Follows existing route pattern
- ✅ Proper error handling with try-catch blocks
- ✅ Input validation for all user inputs
- ✅ Database queries use parameterized statements
- ✅ JSDoc comments for all routes
- ✅ Consistent response format
- ✅ Proper HTTP status codes (400, 403, 404, 500, 501)
- ✅ Logging for debugging
- ✅ Admin-only protection where needed
- ✅ Ownership verification for account stats
- ⚠️ Costs endpoint is a stub

## Next Steps

According to the migration checklist, routes remaining:
- **`campaigns.routes.js`** - No existing endpoints found
- **`analytics.routes.js`** - General analytics (non-AI)
- **`satu-coin.routes.js`** - SatuCoin currency system
- **`webhooks.routes.js`** - Webhook management
- **`admin.routes.js`** - General admin endpoints

---

**Status:** ✅ Mostly Complete (costs endpoint is stub)  
**Reviewed:** Ready for testing (except costs)  
**Integration:** Ready for deployment (use /api/admin/openai/costs for org costs)
