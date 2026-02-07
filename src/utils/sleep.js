// src/utils/sleep.js — Async Sleep Utilities
// -------------------------------------------------

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cooperative sleep with cancellation support
 * Sleeps in small steps and checks for cancellation
 * @param {number} ms - Total milliseconds to sleep
 * @param {Function} shouldCancel - Async function that returns true to cancel
 * @returns {Promise<boolean>} True if cancelled, false if completed
 */
async function sleepCoop(ms, shouldCancel) {
    const step = 500; // 0.5s step
    const end = Date.now() + ms;

    while (Date.now() < end) {
        if (await shouldCancel()) return true; // Cancelled
        await sleep(Math.min(step, end - Date.now()));
    }

    return false; // Completed
}

/**
 * Sleep with random jitter
 * @param {number} ms - Base milliseconds to sleep
 * @param {number} jitter - Maximum jitter in milliseconds (default: 0)
 * @returns {Promise<void>}
 */
async function sleepWithJitter(ms, jitter = 0) {
    const actualMs = ms + Math.random() * jitter;
    return sleep(actualMs);
}

module.exports = {
    sleep,
    sleepCoop,
    sleepWithJitter
};
