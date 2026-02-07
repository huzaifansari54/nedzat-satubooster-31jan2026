// src/app.js — Express Application Setup
// -------------------------------------------------
const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const { getCorsOrigins } = require('./config/cors');
const routes = require('./routes');
const { errorHandler } = require('./middleware/error-handler');
const { cacheControl } = require('./middleware/cache-control');
const { analyticsMiddleware } = require('./middleware/analytics');

const app = express();

// Trust proxy (for deployment behind reverse proxy)
app.set('trust proxy', 1);

// Logging
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
}

// Body parsing middleware
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

// Cookie parser
app.use(cookieParser());

// CORS
app.use(cors({
    origin: getCorsOrigins(),
    credentials: true
}));

// Cache control for HTML/auth routes
app.use(cacheControl);

// Analytics tracking (aid cookie)
app.use(analyticsMiddleware);

// Apple domain association
app.get('/.well-known/apple-developer-domain-association', (req, res) => {
    const filePath = path.join(__dirname, '..', 'public', '.well-known', 'apple-developer-domain-association');
    return res.sendFile(filePath);
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// API Routes
app.use('/api', routes);

// Serve HTML files for SPA routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling middleware (must be last)
app.use(errorHandler);

module.exports = app;
