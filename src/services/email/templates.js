/**
 * Email templates for NeDzat SaaS.
 */

/**
 * Builds the verification email.
 * @param {string} link 
 * @returns {Object} { subject, text, html }
 */
function buildVerifyEmail(link) {
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
    return { subject, text, html };
}

/**
 * Builds the password reset email.
 * @param {string} link 
 * @returns {Object} { subject, text, html }
 */
function buildResetEmail(link) {
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
    return { subject, text, html };
}

module.exports = {
    buildVerifyEmail,
    buildResetEmail
};
