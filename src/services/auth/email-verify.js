// src/services/auth/email-verify.js — Email Verification Service
// -------------------------------------------------

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const db = require('../../database');
const { sha256hex } = require('../../utils/crypto');
const emailService = require('../email/mailer');

/**
 * Generate and send email verification token
 * @param {string} email - User email
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Result object
 */
async function sendVerificationEmail(email, userId) {
    // Generate verification token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256hex(token);
    const expiresAt = Date.now() + 24 * 3600 * 1000; // 24 hours

    // Store token in database
    await db.run(
        `INSERT INTO email_verify_tokens(user_id, token_hash, expires_at, created_at)
     VALUES(?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash=excluded.token_hash,
       expires_at=excluded.expires_at,
       created_at=excluded.created_at`,
        [userId, tokenHash, expiresAt, Date.now()]
    );

    // Send email
    const result = await emailService.sendVerifyEmail(email, token);

    return result;
}

/**
 * Verify email with token
 * @param {string} token - Verification token
 * @returns {Promise<Object>} User object and JWT token
 */
async function verifyEmailToken(token) {
    const tokenHash = sha256hex(token);
    const now = Date.now();

    // Find token
    const tokenRow = await db.get(
        `SELECT user_id, expires_at FROM email_verify_tokens WHERE token_hash=?`,
        [tokenHash]
    );

    if (!tokenRow) {
        throw new Error('Invalid or expired verification token');
    }

    if (tokenRow.expires_at < now) {
        throw new Error('Verification token has expired');
    }

    // Mark email as verified
    await db.run(
        `UPDATE users SET email_verified=1 WHERE id=?`,
        [tokenRow.user_id]
    );

    // Delete used token
    await db.run(
        `DELETE FROM email_verify_tokens WHERE token_hash=?`,
        [tokenHash]
    );

    // Get user
    const user = await db.get(`SELECT * FROM users WHERE id=?`, [tokenRow.user_id]);

    // Generate JWT
    const jwtToken = jwt.sign(
        {
            uid: user.id,
            tid: user.tenant_id,
            role: user.role,
            email: user.email
        },
        config.jwtSecret,
        { expiresIn: '30d' }
    );

    return { user, token: jwtToken };
}

/**
 * Resend verification email
 * @param {string} email - User email
 * @returns {Promise<Object>} Result object
 */
async function resendVerificationEmail(email) {
    const user = await db.get(`SELECT id, email_verified FROM users WHERE email=?`, [email]);

    if (!user) {
        throw new Error('User not found');
    }

    if (user.email_verified === 1) {
        throw new Error('Email already verified');
    }

    return await sendVerificationEmail(email, user.id);
}

module.exports = {
    sendVerificationEmail,
    verifyEmailToken,
    resendVerificationEmail
};
