// src/utils/fetch.js — HTTP Fetch Utilities
// -------------------------------------------------

/**
 * Fetch with timeout support
 * @param {string} url - URL to fetch
 * @param {object} opts - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns {Promise<Response>} Fetch response
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            ...opts,
            signal: controller.signal,
        });
        return res;
    } finally {
        clearTimeout(id);
    }
}

/**
 * Fetch JSON with timeout
 * @param {string} url - URL to fetch
 * @param {object} opts - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns {Promise<any>} Parsed JSON response
 */
async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
    const res = await fetchWithTimeout(url, opts, timeoutMs);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
}

/**
 * Fetch text with timeout
 * @param {string} url - URL to fetch
 * @param {object} opts - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns {Promise<string>} Response text
 */
async function fetchText(url, opts = {}, timeoutMs = 15000) {
    const res = await fetchWithTimeout(url, opts, timeoutMs);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.text();
}

module.exports = {
    fetchWithTimeout,
    fetchJSON,
    fetchText
};
