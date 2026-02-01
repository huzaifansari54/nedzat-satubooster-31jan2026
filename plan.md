# Refactoring Plan: Monolith to Modular Architecture

## Overview
The goal is to refactor the massive `index.js` (16k+ lines) into a structured, maintainable, and scalable architecture. We will adopt a **Service-Oriented / MVC-like structure** within a `src` directory.

## 1. Proposed Directory Structure

```
root/
├── src/
│   ├── config/          # Configuration (DB connection, Env variables, Constants)
│   ├── database/        # Database initialization & migrations
│   ├── middleware/      # Express middleware (Auth, Logger, CORS, ErrorHandler)
│   ├── routes/          # API Route definitions
│   ├── controllers/     # Request handlers (input validation, response formatting)
│   ├── services/        # Business logic (WhatsApp, OpenAI, WABA, Instagram)
│   ├── models/          # Database access layer (Repositories)
│   ├── utils/           # Helper functions
│   ├── jobs/            # Background jobs (Cron, Queues)
│   ├── app.js           # Express App setup
│   └── server.js        # Entry point (Server listener, Socket.IO)
├── panel/               # Frontend (unchanged)
├── uploads/             # User uploads (unchanged)
└── package.json
```

## 2. Step-by-Step Implementation Plan

### Phase 1: Setup & Core Infrastructure
1.  **Backup**: Ensure current code is committed/backed up.
2.  **Scaffold**: Create the `src` directory and subdirectories.
3.  **Config**: 
    - Move `.env` loading and constants to `src/config/env.js`.
    - Move SQLite connection setup to `src/config/db.js`.
4.  **Logging**: Implement `src/config/logger.js` (using Pino/Morgan).

### Phase 2: Database Layer Isolation
1.  **Init Logic**: Extract the huge `initDB()` function and schema creation into `src/database/init.js` or `src/database/schema.js`.
2.  **Models**: Create "Repositories" or "Models" for tables to avoid raw SQL in controllers.
    - `src/models/AccountModel.js`
    - `src/models/ChatModel.js`
    - `src/models/CampaignModel.js`

### Phase 3: Service Extraction (The Heavy Lifting)
Move complex logic out of `index.js` into focused services.
1.  **WhatsApp Service**: Move Baileys socket logic to `src/services/whatsapp/BaileysService.js`.
2.  **WABA Service**: Move `WABAClient` and related logic to `src/services/whatsapp/WabaService.js`.
3.  **AI Service**: Move OpenAI/transcription logic to `src/services/ai/OpenAIService.js`.
4.  **Instagram Service**: Extract Instagram/Graph API logic to `src/services/instagram/InstagramService.js`.

### Phase 4: Route & Controller Extraction
Break down endpoints into separate files.
1.  **Auth**: `src/routes/authRoutes.js` & `src/controllers/authController.js`.
2.  **API**: `src/routes/apiRoutes.js` (CRM, Chats, Accounts).
3.  **Webhooks**: `src/routes/webhookRoutes.js` (WABA, Instagram callbacks).
4.  **Middleware**: Move authentication checks, CORS, and logging to `src/middleware/`.

### Phase 5: App Entry Point
1.  Create `src/app.js` to initialize Express, apply middleware, and mount routes.
2.  Create `src/server.js` to import `app`, setup `Socket.IO`, and start listening.
3.  Update `package.json` to point logic start to `src/server.js`.

## 3. Immediate Action Items (First Steps)
- [ ] Create folder structure.
- [ ] Extract `src/config/db.js` (sqlite connection).
- [ ] Extract `src/database/schema.js` (table setup).
- [ ] Create `src/server.js` (basic entry point).

## 4. Guidelines
- **One thing per file**: A file should logically do one thing (e.g., handle Auth routes).
- **Dependency Injection**: Pass dependencies (like `io` or `db`) where needed, or use a singleton config.
- **Async/Await**: Ensure all DB interactions use `async/await` and proper error handling.
