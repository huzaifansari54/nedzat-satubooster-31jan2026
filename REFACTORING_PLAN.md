# NeDzat SaaS - Refactoring Plan
**Date:** February 3, 2026  
**Current Status:** Monolithic (16,088 lines in index.js)  
**Target:** Modular, Maintainable, Scalable Architecture

---

## 🎯 Objectives

1. **Separate concerns** - Break down the massive `index.js` into logical modules
2. **Improve maintainability** - Make code easier to understand and modify
3. **Enable scalability** - Prepare for future features and team collaboration
4. **Follow best practices** - Align with your existing Flutter app patterns (feature-based architecture)
5. **Zero downtime** - Refactor incrementally without breaking existing functionality

---

## 📁 Proposed Folder Structure

```
nedzat-satubooster-31jan2026/
│
├── .env                          # Environment variables (keep as is)
├── .env.example                  # Environment template (keep as is)
├── .gitignore                    # Git ignore rules
├── package.json                  # Dependencies
├── README.md                     # Project documentation
│
├── server.js                     # Main entry point (minimal, just bootstraps app)
│
├── src/                          # Source code root
│   │
│   ├── config/                   # Configuration files
│   │   ├── index.js             # Main config aggregator
│   │   ├── database.js          # Database configuration
│   │   ├── cors.js              # CORS settings
│   │   ├── multer.js            # File upload config
│   │   ├── oauth.js             # OAuth providers config
│   │   └── constants.js         # App-wide constants
│   │
│   ├── database/                 # Database layer
│   │   ├── index.js             # Database connection & helpers (run, get, all)
│   │   ├── migrations/          # Database migrations
│   │   │   └── init.sql         # Initial schema
│   │   └── seeds/               # Seed data for development
│   │       └── defaults.js      # Default tenant settings
│   │
│   ├── middleware/               # Express middleware
│   │   ├── auth.js              # authGuard, adminOnly, optAuth
│   │   ├── analytics.js         # Analytics tracking (aid cookie)
│   │   ├── cache-control.js     # Cache headers for HTML/auth
│   │   ├── error-handler.js     # Global error handling
│   │   └── rate-limit.js        # Rate limiting (future)
│   │
│   ├── models/                   # Data models (optional, for validation)
│   │   ├── User.js
│   │   ├── Tenant.js
│   │   ├── Campaign.js
│   │   ├── Contact.js
│   │   └── Message.js
│   │
│   ├── services/                 # Business logic layer
│   │   │
│   │   ├── auth/                # Authentication services
│   │   │   ├── index.js
│   │   │   ├── email-auth.js    # Email/password login
│   │   │   ├── google-oauth.js  # Google Sign-In
│   │   │   ├── apple-oauth.js   # Apple Sign-In
│   │   │   ├── email-verify.js  # Email verification
│   │   │   └── password-reset.js # Password reset
│   │   │
│   │   ├── whatsapp/            # WhatsApp Business API
│   │   │   ├── index.js
│   │   │   ├── baileys.js       # Baileys socket management
│   │   │   ├── waba-client.js   # WABA API client (move from waba.js)
│   │   │   ├── message-handler.js # Incoming message processing
│   │   │   └── media-handler.js  # Media download/upload
│   │   │
│   │   ├── instagram/           # Instagram (Meta) integration
│   │   │   ├── index.js
│   │   │   ├── webhook.js       # Instagram webhook handler
│   │   │   └── api-client.js    # Instagram Graph API
│   │   │
│   │   ├── gupshup/             # Gupshup Partner Portal
│   │   │   ├── index.js
│   │   │   ├── auth.js          # Partner token management
│   │   │   ├── app-manager.js   # Create/manage apps
│   │   │   └── webhook.js       # Webhook subscription
│   │   │
│   │   ├── campaigns/           # Campaign management
│   │   │   ├── index.js
│   │   │   ├── campaign-runner.js # Campaign execution
│   │   │   ├── scheduler.js     # Campaign scheduling
│   │   │   └── analytics.js     # Campaign analytics
│   │   │
│   │   ├── ai/                  # AI & OpenAI services
│   │   │   ├── index.js
│   │   │   ├── chat.js          # AI chat responses
│   │   │   ├── embeddings.js    # Text embeddings
│   │   │   ├── knowledge-base.js # RAG knowledge base
│   │   │   └── prompts.js       # AI prompts & templates
│   │   │
│   │   ├── satu-coin/           # SatuCoin payment system
│   │   │   ├── index.js
│   │   │   ├── wallet.js        # Balance management
│   │   │   ├── transactions.js  # Transaction history
│   │   │   └── leads.js         # Lead tracking & charging
│   │   │
│   │   ├── email/               # Email services
│   │   │   ├── index.js
│   │   │   ├── mailer.js        # Nodemailer setup
│   │   │   └── templates.js     # Email templates
│   │   │
│   │   ├── file-processing/     # File upload & processing
│   │   │   ├── index.js
│   │   │   ├── pdf-parser.js    # PDF text extraction
│   │   │   ├── excel-parser.js  # XLSX parsing
│   │   │   ├── doc-parser.js    # DOCX/PPTX parsing
│   │   │   ├── image-ocr.js     # Tesseract OCR
│   │   │   └── chatgpt-export.js # ChatGPT export parser
│   │   │
│   │   ├── analytics/           # Analytics & tracking
│   │   │   ├── index.js
│   │   │   ├── visitor-tracking.js # Visitor analytics
│   │   │   └── geo-parser.js    # GeoIP parsing
│   │   │
│   │   └── crm-sync/            # CRM synchronization
│   │       ├── index.js
│   │       └── supabase-sync.js # Sync with Supabase CRM
│   │
│   ├── routes/                   # API routes (Express routers)
│   │   ├── index.js             # Main router aggregator
│   │   │
│   │   ├── auth.routes.js       # /api/auth/*
│   │   ├── users.routes.js      # /api/users/*
│   │   ├── tenants.routes.js    # /api/tenants/*
│   │   ├── accounts.routes.js   # /api/accounts/* (WhatsApp accounts)
│   │   ├── contacts.routes.js   # /api/contacts/*
│   │   ├── messages.routes.js   # /api/messages/*
│   │   ├── campaigns.routes.js  # /api/campaigns/*
│   │   ├── knowledge.routes.js  # /api/knowledge/*
│   │   ├── ai.routes.js         # /api/ai/*
│   │   ├── analytics.routes.js  # /api/analytics/*
│   │   ├── satu-coin.routes.js  # /api/satu/*
│   │   ├── settings.routes.js   # /api/settings/*
│   │   ├── webhooks.routes.js   # /api/webhooks/* (Instagram, WABA)
│   │   └── admin.routes.js      # /api/admin/*
│   │
│   ├── controllers/              # Route handlers (optional, if routes get complex)
│   │   ├── auth.controller.js
│   │   ├── campaign.controller.js
│   │   └── ...
│   │
│   ├── utils/                    # Utility functions
│   │   ├── index.js
│   │   ├── crypto.js            # sha256hex, token generation
│   │   ├── time.js              # nowSec, startOfUTCDay, getMonthKey
│   │   ├── text.js              # chunkText, htmlToText, roughTokenCount
│   │   ├── file.js              # fileToDataURL
│   │   ├── sleep.js             # sleep, sleepCoop
│   │   ├── fetch.js             # fetchWithTimeout
│   │   └── validators.js        # Input validation helpers
│   │
│   ├── sockets/                  # Socket.IO handlers
│   │   ├── index.js             # Socket.IO setup
│   │   ├── chat.socket.js       # Real-time chat events
│   │   ├── campaign.socket.js   # Campaign progress updates
│   │   └── notification.socket.js # Real-time notifications
│   │
│   └── app.js                    # Express app setup (middleware, routes)
│
├── public/                       # Static files (HTML, CSS, JS)
│   ├── index.html               # Main dashboard
│   ├── login.html               # Login page
│   ├── chat.html                # Chat interface
│   ├── profile.html             # User profile
│   ├── satu-admin.html          # Admin panel
│   │
│   ├── css/                     # Stylesheets
│   │   └── styles.css
│   │
│   ├── js/                      # Client-side JavaScript
│   │   ├── app.js
│   │   ├── auth.js
│   │   └── socket-client.js
│   │
│   ├── assets/                  # Images, fonts, etc.
│   │   └── logo.png
│   │
│   └── .well-known/             # Apple domain association
│       └── apple-developer-domain-association
│
├── uploads/                      # User uploads (keep as is)
│   ├── avatars/
│   └── brand/
│
├── logs/                         # Application logs (new)
│   └── .gitkeep
│
└── tests/                        # Unit & integration tests (future)
    ├── unit/
    └── integration/
```

---

## 🔄 Migration Strategy

### Phase 1: Setup & Preparation (Week 1)
- [ ] Create new folder structure
- [ ] Set up `server.js` as new entry point
- [ ] Create `src/app.js` for Express setup
- [ ] Move static files to `public/`
- [ ] Update `.gitignore`

### Phase 2: Extract Configuration (Week 1)
- [ ] Move all config to `src/config/`
- [ ] Extract database helpers to `src/database/`
- [ ] Create environment config loader

### Phase 3: Extract Utilities (Week 1)
- [ ] Move utility functions to `src/utils/`
- [ ] Create proper exports for each utility module

### Phase 4: Extract Middleware (Week 2)
- [ ] Move `authGuard`, `adminOnly`, `optAuth` to `src/middleware/auth.js`
- [ ] Extract analytics middleware
- [ ] Extract cache control middleware

### Phase 5: Extract Services (Week 2-3)
**Priority order:**
1. Auth services (email, Google, Apple)
2. WhatsApp/Baileys services
3. AI/OpenAI services
4. Campaign services
5. SatuCoin services
6. File processing services
7. Other services

### Phase 6: Create Routes (Week 3-4)
- [ ] Create route files for each feature
- [ ] Move route handlers from `index.js`
- [ ] Test each route module independently

### Phase 7: Socket.IO Refactoring (Week 4)
- [ ] Extract Socket.IO logic to `src/sockets/`
- [ ] Organize by feature (chat, campaigns, notifications)

### Phase 8: Testing & Cleanup (Week 4-5)
- [ ] Test all endpoints
- [ ] Remove old `index.js`
- [ ] Update documentation
- [ ] Performance testing

---

## 🚀 Quick Start (New Structure)

After refactoring, the new entry point will be:

```javascript
// server.js
require('dotenv').config();
const app = require('./src/app');
const http = require('http');

const PORT = process.env.PORT || 3099;
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`🚀 NeDzat SaaS running on port ${PORT}`);
});
```

```javascript
// src/app.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const routes = require('./routes');
const { errorHandler } = require('./middleware/error-handler');
const { setupSocketIO } = require('./sockets');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors(/* config */));

// Static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// API Routes
app.use('/api', routes);

// Error handling
app.use(errorHandler);

module.exports = app;
```

---

## 📊 Benefits of New Structure

### ✅ Maintainability
- **16,088 lines → ~200-500 lines per file**
- Easy to locate and fix bugs
- Clear separation of concerns

### ✅ Scalability
- Add new features without touching existing code
- Easy to add new developers to the team
- Modular testing

### ✅ Code Reusability
- Services can be reused across routes
- Utilities are centralized
- DRY principle enforced

### ✅ Debugging
- Stack traces point to specific files
- Easier to add logging per module
- Better error isolation

### ✅ Team Collaboration
- Multiple developers can work on different features
- Reduced merge conflicts
- Clear ownership of modules

---

## 🎯 Success Metrics

- [ ] All existing functionality works after refactoring
- [ ] No file exceeds 500 lines of code
- [ ] Test coverage > 70%
- [ ] API response times remain the same or improve
- [ ] Zero production bugs during migration

---

## 📝 Notes

1. **Backward Compatibility**: Keep `index.js` as a fallback during migration
2. **Incremental Migration**: Move one service at a time, test thoroughly
3. **Documentation**: Update README.md with new structure
4. **Environment**: No changes to `.env` required
5. **Database**: No schema changes needed

---

## 🔗 References

- Your Flutter app structure: `e:\work\qr app\qr mobile app\kineticQR\lib\`
- Express.js best practices: https://expressjs.com/en/advanced/best-practice-performance.html
- Node.js project structure: https://github.com/goldbergyoni/nodebestpractices

---

**Next Steps:**
1. Review this plan
2. Approve the structure
3. Start with Phase 1 (Setup & Preparation)
4. Migrate incrementally, testing at each step
