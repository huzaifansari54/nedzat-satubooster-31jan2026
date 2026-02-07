// src/services/auth/password-reset.js — Password Reset Service
// -------------------------------------------------

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../database');
const { sha256hex } = require('../../utils/crypto');
const emailService = require('../email/mailer');

/**
 * Request password reset (send reset email)
 * @param {string} email - User email
 * @returns {Promise<Object>} Result object
 */
async function requestPasswordReset(email) {
    const user = await db.get(`SELECT id FROM users WHERE email=?`, [email]);

    if (!user) {
        // Don't reveal if email exists or not (security best practice)
        return { ok: true, message: 'If the email exists, a reset link has been sent' };
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256hex(token);
    const expiresAt = Date.now() + 3600 * 1000; // 1 hour

    // Store token in database
    await db.run(
        `INSERT INTO password_reset_tokens(user_id, token_hash, expires_at, created_at)
     VALUES(?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash=excluded.token_hash,
       expires_at=excluded.expires_at,
       created_at=excluded.created_at`,
        [user.id, tokenHash, expiresAt, Date.now()]
    );

    // Send reset email
    const result = await emailService.sendResetEmail(email, token);

    return result;
}

/**
 * Verify reset token (without resetting password)
 * @param {string} token - Reset token
 * @returns {Promise<boolean>} True if token is valid
 */
async function verifyResetToken(token) {
    const tokenHash = sha256hex(token);
    const now = Date.now();

    const tokenRow = await db.get(
        `SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash=?`,
        [tokenHash]
    );

    if (!tokenRow) {
        return false;
    }

    if (tokenRow.expires_at < now) {
        return false;
    }

    return true;
}

/**
 * Reset password with token
 * @param {string} token - Reset token
 * @param {string} newPassword - New password
 * @returns {Promise<Object>} Result object
 */
async function resetPassword(token, newPassword) {
    const tokenHash = sha256hex(token);
    const now = Date.now();

    // Find token
    const tokenRow = await db.get(
        `SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash=?`,
        [tokenHash]
    );

    if (!tokenRow) {
        throw new Error('Invalid or expired reset token');
    }

    if (tokenRow.expires_at < now) {
        throw new Error('Reset token has expired');
    }

    // Hash new password
    const passHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.run(
        `UPDATE users SET pass_hash=? WHERE id=?`,
        [passHash, tokenRow.user_id]
    );

    // Delete used token
    await db.run(
        `DELETE FROM password_reset_tokens WHERE token_hash=?`,
        [tokenHash]
    );

    return { ok: true, message: 'Password reset successfully' };
}

/**
 * Change password (for authenticated users)
 * @param {number} userId - User ID
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<Object>} Result object
 */
async function changePassword(userId, currentPassword, newPassword) {
    const user = await db.get(`SELECT pass_hash FROM users WHERE id=?`, [userId]);

    if (!user || !user.pass_hash) {
        throw new Error('User not found or password not set');
    }

    // Verify current password
    const valid = await bcrypt.compare(currentPassword, user.pass_hash);
    if (!valid) {
        throw new Error('Current password is incorrect');
    }

    // Hash new password
    const passHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.run(
        `UPDATE users SET pass_hash=? WHERE id=?`,
        [passHash, userId]
    );

    return { ok: true, message: 'Password changed successfully' };
}

module.exports = {
    requestPasswordReset,
    verifyResetToken,
    resetPassword,
    changePassword
};
