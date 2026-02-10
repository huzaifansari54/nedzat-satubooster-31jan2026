// src/services/email/mailer.js — Email Service
// -------------------------------------------------

const nodemailer = require('nodemailer');
const { buildVerifyEmail, buildResetEmail } = require('./templates');

let _mailer = null;

/**
 * Get or create nodemailer transporter
 * @returns {Object|null} Nodemailer transporter or null if not configured
 */
function getMailer() {
  if (_mailer) return _mailer;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  const secure = String(process.env.SMTP_SECURE || '').trim() === '1' ||
    String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const tlsReject = String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '1').trim() !== '0';

  _mailer = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: tlsReject }
  });

  return _mailer;
}

/**
 * Send email verification link
 * @param {string} toEmail - Recipient email
 * @param {string} token - Verification token
 * @returns {Promise<Object>} Result object
 */
async function sendVerifyEmail(toEmail, token) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, error: 'smtp_not_configured' };

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://194.32.141.216:3099';
  const link = `${publicBaseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;

  const { subject, text, html } = buildVerifyEmail(link);

  await mailer.sendMail({ from, to: toEmail, subject, text, html });
  return { ok: true };
}

/**
 * Send password reset link
 * @param {string} toEmail - Recipient email
 * @param {string} token - Reset token
 * @returns {Promise<Object>} Result object
 */
async function sendResetEmail(toEmail, token) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, error: 'smtp_not_configured' };

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://194.32.141.216:3099';
  const link = `${publicBaseUrl}/login.html#reset=${encodeURIComponent(token)}`;

  const { subject, text, html } = buildResetEmail(link);

  await mailer.sendMail({ from, to: toEmail, subject, text, html });
  return { ok: true };
}

module.exports = {
  getMailer,
  sendVerifyEmail,
  sendResetEmail
};
