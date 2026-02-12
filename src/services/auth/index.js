// src/services/auth/index.js — Auth Services Main Export
// -------------------------------------------------

const emailAuth = require('./email-auth');
const emailVerify = require('./email-verify');
const passwordReset = require('./password-reset');
const googleOAuth = require('./google-oauth');
const appleOAuth = require('./apple-oauth');
const cookieHelpers = require('./cookie-helpers');

module.exports = {
    // Email/Password Auth
    registerWithEmail: emailAuth.registerWithEmail,
    loginWithEmail: emailAuth.loginWithEmail,
    isAutoVerifiedEmail: emailAuth.isAutoVerifiedEmail,

    // Email Verification
    sendVerificationEmail: emailVerify.sendVerificationEmail,
    verifyEmailToken: emailVerify.verifyEmailToken,
    resendVerificationEmail: emailVerify.resendVerificationEmail,

    // Password Reset
    requestPasswordReset: passwordReset.requestPasswordReset,
    verifyResetToken: passwordReset.verifyResetToken,
    resetPassword: passwordReset.resetPassword,
    changePassword: passwordReset.changePassword,

    // Google OAuth
    getGoogleAuthUrl: googleOAuth.getAuthorizationUrl,
    exchangeGoogleCode: googleOAuth.exchangeCodeForTokens,
    findOrCreateGoogleUser: googleOAuth.findOrCreateGoogleUser,

    // Apple OAuth
    getAppleClientSecret: appleOAuth.getAppleClientSecret,
    verifyAppleIdToken: appleOAuth.verifyAppleIdToken,
    exchangeAppleCode: appleOAuth.exchangeCodeForTokens,
    findOrCreateAppleUser: appleOAuth.findOrCreateAppleUser,

    // Cookie Helpers
    setAuthCookie: cookieHelpers.setAuthCookie,
    setTempCookie: cookieHelpers.setTempCookie,
    clearAuthCookie: cookieHelpers.clearAuthCookie,

    // Token Helpers
    generateJWT: emailAuth.generateJWT
};
