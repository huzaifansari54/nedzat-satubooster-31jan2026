# NeDzat SaaS - Multi-tenant CRM Platform

A powerful WhatsApp Business API CRM platform with AI-powered chat, campaign management, and SatuCoin payment system.

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ 
- SQLite3

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration
# (SMTP, OAuth keys, OpenAI API key, etc.)

# Start the server
npm start
```

The server will start on `http://localhost:3099` (or the port specified in `.env`).

## 📁 Project Structure

```
nedzat-satubooster-31jan2026/
│
├── server.js                 # Main entry point
├── index.js                  # Legacy monolithic file (to be deprecated)
│
├── src/                      # Source code
│   ├── app.js               # Express app setup
│   ├── config/              # Configuration
│   ├── database/            # Database layer
│   ├── middleware/          # Express middleware
│   ├── models/              # Data models
│   ├── services/            # Business logic
│   │   ├── auth/           # Authentication
│   │   ├── whatsapp/       # WhatsApp Business API
│   │   ├── instagram/      # Instagram integration
│   │   ├── gupshup/        # Gupshup Partner Portal
│   │   ├── campaigns/      # Campaign management
│   │   ├── ai/             # AI & OpenAI services
│   │   ├── satu-coin/      # SatuCoin payment system
│   │   ├── email/          # Email services
│   │   ├── file-processing/ # File upload & processing
│   │   ├── analytics/      # Analytics & tracking
│   │   └── crm-sync/       # CRM synchronization
│   ├── routes/              # API routes
│   ├── controllers/         # Route handlers
│   ├── utils/               # Utility functions
│   └── sockets/             # Socket.IO handlers
│
├── public/                   # Static files (HTML, CSS, JS)
│   ├── index.html           # Main dashboard
│   ├── login.html           # Login page
│   ├── chat.html            # Chat interface
│   ├── profile.html         # User profile
│   ├── satu-admin.html      # Admin panel
│   ├── css/                 # Stylesheets
│   ├── js/                  # Client-side JavaScript
│   ├── assets/              # Images, fonts
│   └── .well-known/         # Apple domain association
│
├── uploads/                  # User uploads
│   ├── avatars/             # User avatars
│   └── brand/               # Brand logos
│
├── logs/                     # Application logs
├── tests/                    # Tests
│   ├── unit/                # Unit tests
│   └── integration/         # Integration tests
│
├── .env                      # Environment variables (not in git)
├── .env.example              # Environment template
├── package.json              # Dependencies
└── REFACTORING_PLAN.md       # Refactoring guide
```

## 🔧 Configuration

All configuration is managed through environment variables in `.env`:

### Server
- `PORT` - Server port (default: 3099)
- `PUBLIC_BASE_URL` - Public URL for callbacks
- `NODE_ENV` - Environment (development/production)

### Security
- `JWT_SECRET` - JWT signing secret

### Database
- SQLite database at `db.sqlite` (auto-created)

### SMTP (Email)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `SMTP_FROM` - From address
- `SMTP_SECURE` - Use TLS (1/0)

### OAuth
- **Google**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Apple**: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH`

### Integrations
- **Instagram**: `IG_APP_ID`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN`
- **Gupshup**: `GUPSHUP_PARTNER_BASE`, `GUPSHUP_PARTNER_EMAIL`, `GUPSHUP_PARTNER_SECRET`
- **OpenAI**: `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`

### SatuCoin
- `SATU_PRICE_PER_LEAD` - Cost per lead (default: 30)

## 📡 API Endpoints

### Health Check
```
GET /api/health
```

### Authentication
```
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/verify?token=...
POST /api/auth/resend-verify
POST /api/auth/forgot-password
POST /api/auth/reset-password
```

### OAuth
```
GET  /api/auth/google
GET  /api/auth/google/callback
GET  /api/auth/apple
POST /api/auth/apple/callback
```

### Users
```
GET    /api/users/me
PUT    /api/users/me
DELETE /api/users/me
```

### Campaigns
```
GET    /api/campaigns
POST   /api/campaigns
GET    /api/campaigns/:id
PUT    /api/campaigns/:id
DELETE /api/campaigns/:id
POST   /api/campaigns/:id/start
POST   /api/campaigns/:id/stop
```

### SatuCoin
```
GET  /api/satu/balance
GET  /api/satu/transactions
POST /api/satu/topup
```

## 🔌 WebSocket Events

Connect to Socket.IO at the server URL:

```javascript
const socket = io('http://localhost:3099');

// Chat events
socket.on('message', (data) => { ... });
socket.emit('send_message', { ... });

// Campaign events
socket.on('campaign_progress', (data) => { ... });
socket.on('campaign_complete', (data) => { ... });

// Notifications
socket.on('notification', (data) => { ... });
```

## 🧪 Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run all tests with coverage
npm run test:coverage
```

## 📦 Deployment

### Production Build
```bash
# Set environment
export NODE_ENV=production

# Start with PM2
pm2 start server.js --name nedzat-saas

# Or use systemd, Docker, etc.
```

### Environment Variables
Ensure all required environment variables are set in production:
- Use strong `JWT_SECRET`
- Configure proper `PUBLIC_BASE_URL`
- Set up SMTP for email
- Configure OAuth credentials
- Add OpenAI API key

## 🔄 Migration Status

This project is currently being refactored from a monolithic `index.js` (16,088 lines) to a modular structure.

**Current Status**: ✅ Folder structure created, starter files in place

**Next Steps**:
1. Extract services from `index.js`
2. Create route modules
3. Migrate Socket.IO handlers
4. Add tests
5. Deprecate old `index.js`

See `REFACTORING_PLAN.md` for detailed migration plan.

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Add tests
4. Submit a pull request

## 📄 License

Proprietary - SatuBooster

## 📞 Support

For support, contact: assylzhan21@gmail.com

---

**Built with ❤️ by the SatuBooster team**
