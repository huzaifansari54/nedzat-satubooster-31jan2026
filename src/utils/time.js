// src/utils/time.js — Time Utilities
// -------------------------------------------------

/**
 * Get current time in seconds (Unix timestamp)
 * @returns {number} Current timestamp in seconds
 */
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Get start of UTC day for a given timestamp
 * @param {number} tsSec - Timestamp in seconds
 * @returns {number} Start of day timestamp in seconds
 */
function startOfUTCDay(tsSec) {
    const d = new Date(tsSec * 1000);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

/**
 * Get month key in format 'YYYY-MM'
 * @param {number} tsMs - Timestamp in milliseconds (default: now)
 * @returns {string} Month key like '2025-12'
 */
function getMonthKey(tsMs = Date.now()) {
    const d = new Date(tsMs);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Format timestamp to ISO date string (YYYY-MM-DD)
 * @param {number} tsMs - Timestamp in milliseconds
 * @returns {string} ISO date string
 */
function toISODate(tsMs = Date.now()) {
    return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * Get timestamp from ISO date string
 * @param {string} isoDate - ISO date string (YYYY-MM-DD)
 * @returns {number} Timestamp in milliseconds
 */
function fromISODate(isoDate) {
    return new Date(isoDate).getTime();
}

module.exports = {
    nowSec,
    startOfUTCDay,
    getMonthKey,
    toISODate,
    fromISODate
};
