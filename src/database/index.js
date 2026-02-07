// src/database/index.js — Database Connection & Helpers
// -------------------------------------------------
// TODO: Move database helpers from index.js
// This file will contain: run, get, all, and other DB utilities

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'db.sqlite');

let db = null;

/**
 * Get database connection
 */
function getDB() {
    if (!db) {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[DB] Failed to connect:', err);
                throw err;
            }
            console.log('[DB] Connected to SQLite database');
        });
    }
    return db;
}

/**
 * Run a query (INSERT, UPDATE, DELETE)
 * Returns: { lastID, changes }
 */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDB().run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

/**
 * Get a single row
 */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDB().get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Get all rows
 */
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDB().all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

/**
 * Close database connection
 */
function close() {
    return new Promise((resolve, reject) => {
        if (db) {
            db.close((err) => {
                if (err) reject(err);
                else {
                    db = null;
                    resolve();
                }
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    getDB,
    run,
    get,
    all,
    close
};
