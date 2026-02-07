// src/config/database.js — Database Configuration
// -------------------------------------------------

const path = require('path');

module.exports = {
    // Database file path
    dbPath: path.join(__dirname, '..', '..', 'db.sqlite'),

    // SQLite options
    options: {
        verbose: process.env.DB_VERBOSE === '1',
        // Add more SQLite-specific options here if needed
    }
};
