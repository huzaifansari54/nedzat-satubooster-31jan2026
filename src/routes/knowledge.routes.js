const express = require('express');
const router = express.Router();
const db = require('../database');
const { authGuard } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');

// Feature flags - would normally come from a config
const FEATURES = {
    KB: 'knowledge_base'
};

// Middleware to check if KB feature is enabled
function requireFeature(feature) {
    return async (req, res, next) => {
        // Stub implementation - in production, check user's feature flags
        // For now, always allow
        next();
    };
}

/**
 * @route GET /api/knowledge/files
 * @desc Get all knowledge base files for tenant
 */
router.get('/files', authGuard, requireFeature(FEATURES.KB), async (req, res) => {
    try {
        const rows = await db.all(
            `SELECT f.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.file_id=f.id) chunks
             FROM kb_files f 
             WHERE tenant_id=? 
             ORDER BY uploaded_at DESC`,
            [req.user.tenant_id]
        );

        res.json({
            ok: true,
            files: rows
        });
    } catch (err) {
        console.error('[KNOWLEDGE] GET /files error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/knowledge/files/:id
 * @desc Get details of a specific knowledge base file
 */
router.get('/files/:id', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const id = Number(req.params.id || 0);

        if (!id) {
            return res.status(400).json({ ok: false, error: 'file id required' });
        }

        const file = await db.get(
            `SELECT * FROM kb_files WHERE id=? AND tenant_id=?`,
            [id, tenantId]
        );

        if (!file) {
            return res.status(404).json({ ok: false, error: 'file not found' });
        }

        // Get chunk count
        const chunkCount = await db.get(
            `SELECT COUNT(*) as count FROM kb_chunks WHERE file_id=?`,
            [id]
        );

        res.json({
            ok: true,
            file: {
                ...file,
                chunks: chunkCount?.count || 0
            }
        });
    } catch (err) {
        console.error('[KNOWLEDGE] GET /files/:id error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/knowledge/files/:id/download
 * @desc Download a knowledge base file
 */
router.get('/files/:id/download', authGuard, async (req, res) => {
    try {
        const tenantId = req.user?.tenant_id;
        const id = Number(req.params.id || 0);

        if (!tenantId || !id) {
            return res.status(400).send('bad_request');
        }

        // Get file record (with tenant_id check)
        const row = await db.get(
            `SELECT id, title, filename, file_kind FROM kb_files WHERE id=? AND tenant_id=?`,
            [id, tenantId]
        );

        if (!row) {
            return res.status(404).send('not_found');
        }

        // If it's a URL - redirect to the link
        if (String(row.file_kind || '') === 'url') {
            const url = String(row.filename || '').trim();
            if (/^https?:\/\//i.test(url)) {
                return res.redirect(url);
            }
            return res.status(400).send('bad_url');
        }

        // Regular uploaded file (uploads/....)
        let rel = String(row.filename || '').replace(/^\/+/, '');
        const uploadsBase = path.resolve(__dirname, '../../uploads');
        const abs = path.resolve(__dirname, '../..', rel);

        // Protection from path traversal: only allow inside ./uploads
        if (!(abs === uploadsBase || abs.startsWith(uploadsBase + path.sep))) {
            return res.status(403).send('forbidden');
        }

        if (!fs.existsSync(abs)) {
            return res.status(404).send('file_missing');
        }

        // Nice filename for download
        const niceName = (String(row.title || '').trim() || path.basename(rel));

        return res.download(abs, niceName);
    } catch (err) {
        console.error('[KNOWLEDGE] download error:', err.message);
        return res.status(500).send('server_error');
    }
});

/**
 * @route POST /api/knowledge/ingest
 * @desc Ingest a file or URL into the knowledge base
 * Note: This is a stub. The full implementation is complex and requires:
 * - File parsing (PDF, DOCX, XLSX, etc.)
 * - Text extraction and chunking
 * - OpenAI embeddings generation
 * - Vector storage
 * The original implementation is in index.js lines 5939-6150
 */
router.post('/ingest', authGuard, requireFeature(FEATURES.KB), async (req, res) => {
    try {
        const { file, url, title } = req.body || {};

        if (!file && !url) {
            return res.status(400).json({ ok: false, error: 'file or url is required' });
        }

        // ⚠️ IMPORTANT: This is a simplified stub implementation
        // The full implementation in index.js (line 5939-6150) handles:
        // - URL fetching and HTML-to-text conversion
        // - File parsing (PDF, DOCX, PPTX, XLSX, CSV, TXT, MD, ZIP)
        // - ChatGPT export parsing
        // - Text chunking (3800 chars per chunk)
        // - OpenAI embedding generation
        // - Vector storage in kb_chunks table
        //
        // For production use, this should be extracted into a service layer:
        // - src/services/knowledge/file-parser.js
        // - src/services/knowledge/embeddings.js
        // - src/services/knowledge/chunker.js

        res.status(501).json({
            ok: false,
            error: 'ingest_not_implemented',
            message: 'Knowledge base ingestion is still handled by the legacy /api/kb/ingest endpoint in index.js. ' +
                'To complete this route, extract the file parsing and embedding logic from index.js lines 5939-6150 ' +
                'into dedicated service modules.'
        });

    } catch (err) {
        console.error('[KNOWLEDGE] POST /ingest error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * @route DELETE /api/knowledge/files/:id
 * @desc Delete a knowledge base file and its chunks
 */
router.delete('/files/:id', authGuard, async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!id) {
            return res.status(400).json({ ok: false, error: 'file id required' });
        }

        // Verify ownership
        const own = await db.get(
            `SELECT id FROM kb_files WHERE id=? AND tenant_id=?`,
            [id, req.user.tenant_id]
        );

        if (!own) {
            return res.status(404).json({ ok: false, error: 'file not found' });
        }

        // Delete chunks first (foreign key relationship)
        await db.run(`DELETE FROM kb_chunks WHERE file_id=?`, [id]);

        // Then delete the file record
        await db.run(`DELETE FROM kb_files WHERE id=?`, [id]);

        res.json({ ok: true, message: 'File deleted successfully' });
    } catch (err) {
        console.error('[KNOWLEDGE] DELETE /files/:id error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/knowledge/search
 * @desc Search knowledge base using semantic similarity
 * Note: This requires vector similarity search with embeddings
 */
router.get('/search', authGuard, requireFeature(FEATURES.KB), async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));

        if (!query) {
            return res.status(400).json({ ok: false, error: 'query required' });
        }

        // ⚠️ STUB: Full implementation requires:
        // 1. Generate embedding for query using OpenAI API
        // 2. Calculate cosine similarity with all kb_chunks embeddings
        // 3. Return top N most similar chunks
        // 4. Group by file_id and provide context

        res.status(501).json({
            ok: false,
            error: 'search_not_implemented',
            message: 'Knowledge base search requires embedding generation and vector similarity. ' +
                'Implementation should use the cosine similarity function from index.js and ' +
                'compare query embeddings against stored chunk embeddings.'
        });

    } catch (err) {
        console.error('[KNOWLEDGE] GET /search error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

/**
 * @route GET /api/knowledge/stats
 * @desc Get knowledge base statistics for tenant
 */
router.get('/stats', authGuard, async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const [
            totalFiles,
            totalChunks,
            totalTokens,
            filesByType
        ] = await Promise.all([
            db.get(`SELECT COUNT(*) as count FROM kb_files WHERE tenant_id=?`, [tenantId]),
            db.get(`SELECT COUNT(*) as count FROM kb_chunks WHERE tenant_id=?`, [tenantId]),
            db.get(`SELECT SUM(tokens) as sum FROM kb_chunks WHERE tenant_id=?`, [tenantId]),
            db.all(`SELECT file_kind, COUNT(*) as count FROM kb_files WHERE tenant_id=? GROUP BY file_kind`, [tenantId])
        ]);

        res.json({
            ok: true,
            stats: {
                total_files: totalFiles?.count || 0,
                total_chunks: totalChunks?.count || 0,
                total_tokens: totalTokens?.sum || 0,
                by_type: filesByType || []
            }
        });
    } catch (err) {
        console.error('[KNOWLEDGE] GET /stats error:', err.message);
        res.status(500).json({ ok: false, error: 'server error' });
    }
});

module.exports = router;
