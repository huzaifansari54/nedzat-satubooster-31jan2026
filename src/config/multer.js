// src/config/multer.js — File Upload Configuration
// -------------------------------------------------

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// Storage configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext)
            .replace(/[^a-z0-9_-]/gi, '_')
            .slice(0, 32);
        cb(null, `${base}-${uniqueSuffix}${ext}`);
    }
});

// File filter (optional, can be customized per route)
const fileFilter = (req, file, cb) => {
    // Accept all files by default
    // Add specific filters in route handlers if needed
    cb(null, true);
};

// Multer instance
const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max file size
    }
});

module.exports = {
    upload,
    UPLOAD_DIR,
    storage,
    fileFilter
};
