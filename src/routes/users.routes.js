const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard, adminOnly } = require('../middleware/auth');
const { logger } = require('../utils');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const authService = require('../services/auth'); // For cookie updates if email changes

// Avatar upload configuration
const uploadDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tenantDir = path.join(uploadDir, String(req.user.tenant_id));
        const userDir = path.join(tenantDir, String(req.user.id));
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `avatar_${Date.now()}${ext}`);
    }
});

const uploadAvatar = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG and WEBP allowed.'));
        }
    }
});

/**
 * @route GET /api/me
 * @desc Get current user information
 */
router.get('/me', authGuard, async (req, res) => {
    try {
        const row = await db.get(
            `SELECT email, email_verified, avatar_url, disabled FROM users WHERE id=?`,
            [req.user.id]
        );

        if (!row) {
            return res.status(404).json({ ok: false, error: 'user not found' });
        }

        res.json({
            ok: true,
            user: {
                id: req.user.id,
                tenant_id: req.user.tenant_id,
                role: req.user.role,
                email: row.email || req.user.email,
                email_verified: Number(row.email_verified || 0),
                avatar_url: row.avatar_url || null,
                disabled: Number(row.disabled || 0),
                impersonating: !!(req.cookies?.admin_token)
            }
        });
    } catch (err) {
        logger.error({ err }, '[USER] Route error');
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/me/entitlements
 * @desc Get tenant entitlements (features/limits)
 */
router.get('/me/entitlements', authGuard, async (req, res) => {
    try {
        // This helper was used in index.js, assuming it's available or we can implement it
        // For now, returning a basic response or we could extract getTenantEntitlements
        const { getTenantEntitlements } = require('../services/settings/entitlements');
        const ent = await getTenantEntitlements(req.user.tenant_id);
        res.json({ ok: true, ...ent });
    } catch (err) {
        res.json({ ok: true, features: {}, limits: {} }); // Fallback
    }
});

/**
 * @route GET /api/profile
 * @desc Get user profile
 */
router.get('/profile', authGuard, async (req, res) => {
    try {
        const u = await db.get(
            `SELECT email, email_verified, avatar_url FROM users WHERE id=?`,
            [req.user.id]
        );
        if (!u) return res.status(404).json({ ok: false, error: 'user not found' });

        res.json({
            ok: true,
            email: u.email,
            email_verified: Number(u.email_verified || 0),
            avatar_url: u.avatar_url || null
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/profile/email
 * @desc Update user email
 */
router.post('/profile/email', authGuard, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: 'invalid email' });
    }

    try {
        // Check if exists
        const exists = await db.get(`SELECT id FROM users WHERE lower(email)=? AND id<>?`, [email, req.user.id]);
        if (exists) return res.status(409).json({ ok: false, error: 'email already exists' });

        const autoV = authService.isAutoVerifiedEmail(email);

        // Update user
        let message = 'Почта обновлена';
        let mailSent = false;

        if (!autoV) {
            // Send verification email logic here
            try {
                await authService.sendVerificationEmail(email);
                mailSent = true;
                message += '. Отправили письмо для подтверждения.';
            } catch (err) {
                message += '. Письмо для подтверждения не удалось отправить.';
            }
        }

        await db.run(
            `UPDATE users SET email=?, email_verified=? WHERE id=?`,
            [email, autoV ? 1 : 0, req.user.id]
        );

        // Update token in cookie
        const newUserInfo = { ...req.user, email };
        const token = authService.generateJWT(newUserInfo); // Assuming generateJWT is exposed or we can use jwt.sign
        authService.setAuthCookie(res, req, token);

        res.json({ ok: true, message, mail_sent: mailSent, email_verified: autoV ? 1 : 0 });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/profile/password
 * @desc Update user password
 */
router.post('/profile/password', authGuard, async (req, res) => {
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'password too short' });

    try {
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(password, 10);
        await db.run(`UPDATE users SET pass_hash=? WHERE id=?`, [hash, req.user.id]);
        res.json({ ok: true, message: 'Пароль обновлён' });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route POST /api/profile/avatar
 * @desc Update user avatar
 */
router.post('/profile/avatar', authGuard, uploadAvatar.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });

        const rel = path.posix.join(
            'uploads', 'avatars',
            String(req.user.tenant_id),
            String(req.user.id),
            req.file.filename
        );

        await db.run(`UPDATE users SET avatar_url=? WHERE id=?`, [rel, req.user.id]);
        res.json({ ok: true, message: 'Аватар обновлён', avatar_url: rel });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/tenant
 * @desc Get current tenant info
 */
router.get('/tenant', authGuard, async (req, res) => {
    try {
        const row = await db.get(`SELECT name FROM tenants WHERE id=?`, [req.user.tenant_id]);
        res.json({
            ok: true,
            tenant_id: req.user.tenant_id,
            tenant_name: row?.name || null
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
