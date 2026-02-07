// src/services/email/mailer.js — Email Service
// -------------------------------------------------

const nodemailer = require('nodemailer');

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

    const subject = 'Подтверждение почты';
    const text = `Здравствуйте!\n\nПодтвердите почту по ссылке:\n${link}\n\nЕсли это не вы — просто игнорируйте письмо.`;
    const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Подтверждение почты</h2>
      <p>Нажмите кнопку, чтобы подтвердить email:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0ea5e9;color:#fff;text-decoration:none">Подтвердить почту</a></p>
      <p style="color:#64748b;font-size:12px">Если это не вы — игнорируйте письмо.</p>
    </div>
  `;

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

    const subject = 'Сброс пароля';
    const text = `Здравствуйте!\n\nСброс пароля по ссылке:\n${link}\n\nЕсли это не вы — просто игнорируйте письмо.`;
    const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>Сброс пароля</h2>
      <p>Нажмите кнопку, чтобы задать новый пароль:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0ea5e9;color:#fff;text-decoration:none">Сбросить пароль</a></p>
      <p style="color:#64748b;font-size:12px">Если это не вы — игнорируйте письмо.</p>
    </div>
  `;

    await mailer.sendMail({ from, to: toEmail, subject, text, html });
    return { ok: true };
}

module.exports = {
    getMailer,
    sendVerifyEmail,
    sendResetEmail
};
