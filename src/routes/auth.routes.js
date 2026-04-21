const express = require('express');
const router = express.Router();
const config = require('../config');
const crypto = require('crypto');
const authService = require('../services/auth');
const { authGuard } = require('../middleware/auth');
const { logger } = require('../utils');

/**
 * @route POST /api/auth/bootstrap
 * @desc Bootstrap the application (disabled by default)
 */
router.post('/bootstrap', async (req, res) => {
    return res.status(403).json({
        ok: false,
        error: 'bootstrap disabled; use /api/auth/register_public'
    });
});

/**
 * @route POST /api/auth/signup
 * @desc Create a new user for the current tenant (admin only)
 */
router.post('/signup', authGuard, async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { email, password, role = 'user' } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email,password required' });
    }

    try {
        await authService.registerWithEmail({ email, password, role });
        logger.info({ email, role, adminId: req.user.id }, '[AUTH] Manual signup successful');
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, email }, '[AUTH] Signup error');
        res.status(500).json({ ok: false, error: err.message || 'server error' });
    }
});

/**
 * @route POST /api/auth/login
 * @desc Login with email and password
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email,password required' });
    }

    try {
        const { user, token } = await authService.loginWithEmail({ email, password });

        // Check if verified
        const isVerified = Number(user.email_verified || 0) === 1;
        if (!isVerified) {
            logger.warn({ email, userId: user.id }, '[AUTH] Login blocked: Email not verified');
            return res.status(403).json({ ok: false, error: 'email not verified' });
        }

        authService.setAuthCookie(res, req, token);
        logger.info({ userId: user.id, email }, '[AUTH] User logged in');
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, email }, '[AUTH] Login error');
        res.status(401).json({ ok: false, error: err.message || 'invalid credentials' });
    }
});

/**
 * @route GET /api/auth/google/start
 * @desc Start Google OAuth flow
 */
router.get('/google/start', (req, res) => {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        authService.setTempCookie(res, req, 'oauth_state_google', state, 10 * 60 * 1000);

        const redirectUri = `${config.publicBaseUrl}/api/auth/google/callback`;
        const url = authService.getGoogleAuthUrl(redirectUri, state);
        logger.info('[AUTH] Starting Google OAuth flow');
        res.redirect(url);
    } catch (err) {
        logger.error({ err }, '[AUTH] Google start error');
        res.status(500).send('Google OAuth configuration error');
    }
});

/**
 * @route GET /api/auth/google/callback
 * @desc Google OAuth callback
 */
router.get('/google/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query || {};
        if (error) {
            logger.warn({ error }, '[AUTH] Google callback error from Meta');
            return res.redirect('/login.html?oauth_error=google');
        }

        const expected = req.cookies?.oauth_state_google;
        res.clearCookie('oauth_state_google', { path: '/' });

        if (!code || !state || !expected || String(state) !== String(expected)) {
            logger.warn('[AUTH] Google state mismatch or missing parameters');
            return res.redirect('/login.html?oauth_error=google_state');
        }

        const redirectUri = `${config.publicBaseUrl}/api/auth/google/callback`;
        const googleUser = await authService.exchangeGoogleCode(code, redirectUri);
        const { user, token } = await authService.findOrCreateGoogleUser(googleUser);

        authService.setAuthCookie(res, req, token);
        logger.info({ userId: user.id }, '[AUTH] Google login successful');
        res.redirect('/?r=' + Date.now());
    } catch (err) {
        logger.error({ err }, '[AUTH] Google callback exception');
        const errorType = err.code === 'SIGNUP_DISABLED' ? 'signup_disabled' : 'google_fail';
        res.redirect(`/login.html?oauth_error=${errorType}`);
    }
});

/**
 * @route GET /api/auth/apple/start
 * @desc Start Apple OAuth flow
 */
router.get('/apple/start', (req, res) => {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        const nonce = crypto.randomBytes(16).toString('hex');

        authService.setTempCookie(res, req, 'oauth_state_apple', state, 10 * 60 * 1000, { sameSite: 'none' });
        authService.setTempCookie(res, req, 'oauth_nonce_apple', nonce, 10 * 60 * 1000, { sameSite: 'none' });

        const redirectUri = `${config.publicBaseUrl}/api/auth/apple/callback`;

        const qs = new URLSearchParams({
            response_type: 'code',
            response_mode: 'form_post',
            client_id: process.env.APPLE_CLIENT_ID,
            redirect_uri: redirectUri,
            scope: 'name email',
            state,
            nonce
        });

        logger.info('[AUTH] Starting Apple OAuth flow');
        res.redirect(`https://appleid.apple.com/auth/authorize?${qs.toString()}`);
    } catch (err) {
        logger.error({ err }, '[AUTH] Apple start error');
        res.status(500).send('Apple OAuth configuration error');
    }
});

/**
 * @route POST /api/auth/apple/callback
 * @desc Apple OAuth callback (form_post)
 */
const handleAppleCallback = async (req, res) => {
    try {
        const code = String(req.body?.code || req.query?.code || '');
        const state = String(req.body?.state || req.query?.state || '');
        const userRaw = req.body?.user;

        const expected = req.cookies?.oauth_state_apple;
        res.clearCookie('oauth_state_apple', { path: '/' });
        res.clearCookie('oauth_nonce_apple', { path: '/' });

        if (!code || !state || !expected || state !== String(expected)) {
            logger.warn('[AUTH] Apple state mismatch or missing parameters');
            return res.redirect('/login.html?oauth_error=apple_state');
        }

        const redirectUri = `${config.publicBaseUrl}/api/auth/apple/callback`;
        const { userInfo } = await authService.exchangeAppleCode(code, redirectUri);

        let userForm = {};
        if (userRaw) {
            try {
                const u = JSON.parse(String(userRaw));
                const first = u?.name?.firstName || '';
                const last = u?.name?.lastName || '';
                userForm.name = (first + ' ' + last).trim();
            } catch (_) { }
        }

        const { user, token } = await authService.findOrCreateAppleUser(userInfo, userForm);

        authService.setAuthCookie(res, req, token);
        logger.info({ userId: user.id }, '[AUTH] Apple login successful');
        res.redirect('/?r=' + Date.now());
    } catch (err) {
        logger.error({ err }, '[AUTH] Apple callback error');
        const errorType = err.code === 'SIGNUP_DISABLED' ? 'signup_disabled' : 'apple_fail';
        res.redirect(`/login.html?oauth_error=${errorType}`);
    }
};

router.post('/apple/callback', handleAppleCallback);
router.get('/apple/callback', handleAppleCallback);

/**
 * @route POST /api/auth/logout
 * @desc Logout user
 */
router.post('/logout', authGuard, (req, res) => {
    authService.clearAuthCookie(res);
    res.json({ ok: true });
});

/**
 * @route GET /api/auth/open_signup
 * @desc Check if public registration is enabled
 */
router.get('/open_signup', async (req, res) => {
    try {
        const { getSetting } = require('../services/settings');
        const enabled = (await getSetting('open_signup', 1) || '0') === '1';
        const role = (await getSetting('open_signup_role', 1) || 'user');
        res.json({ enabled, role });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/auth/verify
 * @desc Verify email with token
 */
router.get('/verify', async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).send('Bad request');

    try {
        await authService.verifyEmailToken(token);
        logger.info({ token }, '[AUTH] Email verified successfully');
        res.redirect('/?verified=1');
    } catch (err) {
        logger.error({ err, token }, '[AUTH] Verify error');
        res.status(400).send('Invalid or expired token');
    }
});

/**
 * @route POST /api/auth/resend_verify
 * @desc Resend verification email
 */
router.post('/resend_verify', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });

    try {
        const result = await authService.resendVerificationEmail(email);
        logger.info({ email }, '[AUTH] Verification email resent');
        res.json(result);
    } catch (err) {
        if (err.code === 'cooldown') {
            return res.status(429).json({ ok: false, error: 'cooldown', retry_in: err.retry_in });
        }
        logger.error({ err, email }, '[AUTH] Resend verify error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/auth/forgot_password
 * @desc Request password reset
 */
router.post('/forgot_password', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });

    try {
        const result = await authService.requestPasswordReset(email);
        res.json(result);
    } catch (err) {
        if (err.code === 'cooldown') {
            return res.status(429).json({ ok: false, error: 'cooldown', retry_in: err.retry_in });
        }
        console.error('[AUTH] Forgot password error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/auth/reset_password
 * @desc Reset password with token
 */
router.post('/reset_password', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token required' });
    if (!password || password.length < 8) {
        return res.status(400).json({ ok: false, error: 'password too short' });
    }

    try {
        await authService.resetPassword({ token, password });
        logger.info({ token }, '[AUTH] Password reset successful');
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err, token }, '[AUTH] Reset password error');
        res.status(400).json({ ok: false, error: err.message || 'invalid or expired token' });
    }
});

/**
 * @route POST /api/auth/register_public
 * @desc Public registration for new tenants
 */
router.post('/register_public', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email,password required' });
    }

    try {
        const { user, token, emailVerified } = await authService.registerWithEmail({ email, password });

        // Set auth cookie
        authService.setAuthCookie(res, req, token);
        logger.info({ userId: user.id, email }, '[AUTH] Public registration successful');

        if (emailVerified) {
            return res.json({ ok: true, auto_verified: true });
        }

        // Send verification email
        try {
            await authService.sendVerificationEmail(email);
        } catch (mailErr) {
            logger.warn({ err: mailErr, email }, '[AUTH] Registration verification email failed');
        }

        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'SIGNUP_DISABLED') {
            return res.status(403).json({ ok: false, error: 'open_signup disabled' });
        }
        if (err.message === 'Email already registered') {
            return res.status(409).json({ ok: false, error: 'email already exists' });
        }
        logger.error({ err, email }, '[AUTH] Public registration error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
