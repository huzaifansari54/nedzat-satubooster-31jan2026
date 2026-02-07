// ===================================================================
// WHATSAPP MEDIA HANDLER
// ===================================================================
// Purpose: Handle media upload, download, and processing for WhatsApp
// Supports images, videos, audio, documents

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fileToDataURL } = require('../../utils/file');

/**
 * Supported media types for WhatsApp
 */
const MEDIA_TYPES = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    DOCUMENT: 'document',
    STICKER: 'sticker',
    VOICE: 'voice'
};

/**
 * Maximum file sizes (in bytes) for WhatsApp media
 */
const MAX_FILE_SIZES = {
    [MEDIA_TYPES.IMAGE]: 5 * 1024 * 1024,      // 5 MB
    [MEDIA_TYPES.VIDEO]: 16 * 1024 * 1024,     // 16 MB
    [MEDIA_TYPES.AUDIO]: 16 * 1024 * 1024,     // 16 MB
    [MEDIA_TYPES.DOCUMENT]: 100 * 1024 * 1024, // 100 MB
    [MEDIA_TYPES.STICKER]: 500 * 1024,         // 500 KB
    [MEDIA_TYPES.VOICE]: 16 * 1024 * 1024      // 16 MB
};

/**
 * Supported MIME types for each media type
 */
const SUPPORTED_MIME_TYPES = {
    [MEDIA_TYPES.IMAGE]: ['image/jpeg', 'image/png'],
    [MEDIA_TYPES.VIDEO]: ['video/mp4', 'video/3gpp'],
    [MEDIA_TYPES.AUDIO]: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    [MEDIA_TYPES.DOCUMENT]: [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/msword',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ],
    [MEDIA_TYPES.STICKER]: ['image/webp']
};

/**
 * Validate media file
 * @param {string} filePath - Path to media file
 * @param {string} mediaType - Type of media (image, video, audio, document)
 * @returns {Object} { valid: boolean, error?: string, mimeType?: string, size?: number }
 */
async function validateMedia(filePath, mediaType) {
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return { valid: false, error: 'File not found' };
        }

        // Get file stats
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        // Check file size
        const maxSize = MAX_FILE_SIZES[mediaType];
        if (maxSize && fileSize > maxSize) {
            return {
                valid: false,
                error: `File size (${(fileSize / 1024 / 1024).toFixed(2)} MB) exceeds maximum allowed (${(maxSize / 1024 / 1024).toFixed(2)} MB)`
            };
        }

        // Detect MIME type from extension
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = 'application/octet-stream';

        const mimeMap = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
            '.3gp': 'video/3gpp',
            '.aac': 'audio/aac',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
            '.amr': 'audio/amr',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.ppt': 'application/vnd.ms-powerpoint',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        };

        mimeType = mimeMap[ext] || mimeType;

        // Check MIME type support
        const supportedTypes = SUPPORTED_MIME_TYPES[mediaType];
        if (supportedTypes && !supportedTypes.includes(mimeType)) {
            return {
                valid: false,
                error: `MIME type ${mimeType} not supported for ${mediaType}. Supported types: ${supportedTypes.join(', ')}`
            };
        }

        return {
            valid: true,
            mimeType,
            size: fileSize
        };
    } catch (error) {
        return {
            valid: false,
            error: error.message
        };
    }
}

/**
 * Optimize image for WhatsApp (compress and resize if needed)
 * @param {string} inputPath - Input image path
 * @param {string} outputPath - Output image path
 * @param {Object} options - Optimization options
 * @returns {Promise<Object>} { success: boolean, path?: string, error?: string }
 */
async function optimizeImage(inputPath, outputPath, options = {}) {
    try {
        const {
            maxWidth = 1600,
            maxHeight = 1600,
            quality = 80,
            format = 'jpeg'
        } = options;

        await sharp(inputPath)
            .resize(maxWidth, maxHeight, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality })
            .toFile(outputPath);

        return {
            success: true,
            path: outputPath
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Create thumbnail for media
 * @param {string} inputPath - Input media path
 * @param {string} outputPath - Output thumbnail path
 * @param {number} size - Thumbnail size (width/height)
 * @returns {Promise<Object>} { success: boolean, path?: string, error?: string }
 */
async function createThumbnail(inputPath, outputPath, size = 200) {
    try {
        await sharp(inputPath)
            .resize(size, size, {
                fit: 'cover',
                position: 'center'
            })
            .jpeg({ quality: 70 })
            .toFile(outputPath);

        return {
            success: true,
            path: outputPath
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Save media buffer to file
 * @param {Buffer} buffer - Media buffer
 * @param {string} outputDir - Output directory
 * @param {string} filename - Output filename
 * @returns {Promise<string>} File path
 */
async function saveMediaBuffer(buffer, outputDir, filename) {
    // Create directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, filename);
    await fs.promises.writeFile(filePath, buffer);

    return filePath;
}

/**
 * Get media info from file
 * @param {string} filePath - Path to media file
 * @returns {Promise<Object>} Media info
 */
async function getMediaInfo(filePath) {
    try {
        const stats = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();

        const info = {
            path: filePath,
            filename: path.basename(filePath),
            size: stats.size,
            extension: ext,
            mimeType: 'application/octet-stream'
        };

        // Try to get image metadata if it's an image
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            try {
                const metadata = await sharp(filePath).metadata();
                info.width = metadata.width;
                info.height = metadata.height;
                info.format = metadata.format;
            } catch (e) {
                // Not an image or corrupted
            }
        }

        return info;
    } catch (error) {
        throw new Error(`Failed to get media info: ${error.message}`);
    }
}

/**
 * Convert media to data URL
 * @param {string} filePath - Path to media file
 * @returns {Promise<string>} Data URL
 */
async function mediaToDataURL(filePath) {
    return await fileToDataURL(filePath);
}

/**
 * Clean up old media files
 * @param {string} directory - Directory to clean
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {Promise<number>} Number of files deleted
 */
async function cleanupOldMedia(directory, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    try {
        if (!fs.existsSync(directory)) {
            return 0;
        }

        const files = fs.readdirSync(directory);
        const now = Date.now();
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(directory, file);
            const stats = fs.statSync(filePath);

            if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }

        return deletedCount;
    } catch (error) {
        console.error('[MediaHandler] Cleanup error:', error);
        return 0;
    }
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension (with dot)
 */
function getExtensionFromMimeType(mimeType) {
    const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'audio/aac': '.aac',
        'audio/mpeg': '.mp3',
        'audio/ogg': '.ogg',
        'audio/amr': '.amr',
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.ms-powerpoint': '.ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
    };

    return mimeToExt[mimeType] || '.bin';
}

module.exports = {
    MEDIA_TYPES,
    MAX_FILE_SIZES,
    SUPPORTED_MIME_TYPES,
    validateMedia,
    optimizeImage,
    createThumbnail,
    saveMediaBuffer,
    getMediaInfo,
    mediaToDataURL,
    cleanupOldMedia,
    getExtensionFromMimeType
};
