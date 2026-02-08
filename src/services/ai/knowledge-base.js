/**
 * AI Knowledge Base Service
 * Handles RAG (Retrieval-Augmented Generation) knowledge base operations
 */

const { generateEmbedding, cosineSimilarity } = require('./embeddings');
const { get, all, run } = require('../../database');

/**
 * Add document to knowledge base
 * Chunks the document, generates embeddings, and stores in database
 * 
 * @param {object} params - Document parameters
 * @param {number} params.tenantId - Tenant ID
 * @param {number} params.accountId - Account ID
 * @param {string} params.apiKey - OpenAI API key
 * @param {string} params.text - Document text
 * @param {string} [params.title] - Document title
 * @param {object} [params.metadata] - Additional metadata
 * @param {number} [params.chunkSize=3800] - Characters per chunk
 * @returns {Promise<object>} Result with document ID and chunk count
 */
async function addDocument(params) {
    const {
        tenantId,
        accountId,
        apiKey,
        text,
        title = 'Untitled',
        metadata = {},
        chunkSize = 3800
    } = params;

    if (!tenantId || !accountId || !apiKey || !text) {
        throw new Error('tenantId, accountId, apiKey, and text are required');
    }

    try {
        // Chunk the text
        const chunks = chunkText(text, chunkSize);

        if (chunks.length === 0) {
            throw new Error('No chunks generated from text');
        }

        const now = Date.now();
        const docId = `doc_${now}_${Math.random().toString(36).slice(2, 11)}`;

        // Generate embeddings for each chunk
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const embedding = await generateEmbedding(apiKey, chunk);

            // Store chunk with embedding
            await run(
                `INSERT INTO knowledge_chunks 
         (tenant_id, acc_id, doc_id, chunk_index, chunk_text, embedding, title, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    accountId,
                    docId,
                    i,
                    chunk,
                    JSON.stringify(embedding),
                    title,
                    JSON.stringify(metadata),
                    now
                ]
            );
        }

        console.log(`[AI][KB] Added document ${docId} with ${chunks.length} chunks`);

        return {
            ok: true,
            docId,
            chunkCount: chunks.length
        };
    } catch (error) {
        console.error('[AI][KB] Add document failed:', error?.message || error);
        throw error;
    }
}

/**
 * Search knowledge base using semantic similarity
 * 
 * @param {object} params - Search parameters
 * @param {number} params.tenantId - Tenant ID
 * @param {number} params.accountId - Account ID
 * @param {string} params.apiKey - OpenAI API key
 * @param {string} params.query - Search query
 * @param {number} [params.limit=5] - Max results to return
 * @param {number} [params.threshold=0.7] - Minimum similarity threshold (0-1)
 * @returns {Promise<Array>} Array of matching chunks with similarity scores
 */
async function searchKnowledgeBase(params) {
    const {
        tenantId,
        accountId,
        apiKey,
        query,
        limit = 5,
        threshold = 0.7
    } = params;

    if (!tenantId || !accountId || !apiKey || !query) {
        throw new Error('tenantId, accountId, apiKey, and query are required');
    }

    try {
        // Generate embedding for query
        const queryEmbedding = await generateEmbedding(apiKey, query);

        // Get all chunks for this account
        const chunks = await all(
            `SELECT id, doc_id, chunk_index, chunk_text, embedding, title, metadata
       FROM knowledge_chunks
       WHERE tenant_id = ? AND acc_id = ?
       ORDER BY created_at DESC`,
            [tenantId, accountId]
        );

        if (!chunks || chunks.length === 0) {
            return [];
        }

        // Calculate similarity for each chunk
        const results = [];

        for (const chunk of chunks) {
            try {
                const chunkEmbedding = JSON.parse(chunk.embedding);
                const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

                if (similarity >= threshold) {
                    results.push({
                        id: chunk.id,
                        docId: chunk.doc_id,
                        chunkIndex: chunk.chunk_index,
                        text: chunk.chunk_text,
                        title: chunk.title,
                        metadata: JSON.parse(chunk.metadata || '{}'),
                        similarity
                    });
                }
            } catch (err) {
                console.error('[AI][KB] Error processing chunk:', err);
            }
        }

        // Sort by similarity (highest first) and limit
        results.sort((a, b) => b.similarity - a.similarity);

        return results.slice(0, limit);
    } catch (error) {
        console.error('[AI][KB] Search failed:', error?.message || error);
        throw error;
    }
}

/**
 * Delete document from knowledge base
 * 
 * @param {object} params - Delete parameters
 * @param {number} params.tenantId - Tenant ID
 * @param {number} params.accountId - Account ID
 * @param {string} params.docId - Document ID to delete
 * @returns {Promise<object>} Result with deleted chunk count
 */
async function deleteDocument(params) {
    const { tenantId, accountId, docId } = params;

    if (!tenantId || !accountId || !docId) {
        throw new Error('tenantId, accountId, and docId are required');
    }

    try {
        const result = await run(
            `DELETE FROM knowledge_chunks
       WHERE tenant_id = ? AND acc_id = ? AND doc_id = ?`,
            [tenantId, accountId, docId]
        );

        console.log(`[AI][KB] Deleted document ${docId} (${result.changes} chunks)`);

        return {
            ok: true,
            deletedChunks: result.changes || 0
        };
    } catch (error) {
        console.error('[AI][KB] Delete document failed:', error?.message || error);
        throw error;
    }
}

/**
 * List all documents in knowledge base
 * 
 * @param {object} params - List parameters
 * @param {number} params.tenantId - Tenant ID
 * @param {number} params.accountId - Account ID
 * @returns {Promise<Array>} Array of documents with metadata
 */
async function listDocuments(params) {
    const { tenantId, accountId } = params;

    if (!tenantId || !accountId) {
        throw new Error('tenantId and accountId are required');
    }

    try {
        const docs = await all(
            `SELECT doc_id, title, metadata, COUNT(*) as chunk_count, MIN(created_at) as created_at
       FROM knowledge_chunks
       WHERE tenant_id = ? AND acc_id = ?
       GROUP BY doc_id
       ORDER BY created_at DESC`,
            [tenantId, accountId]
        );

        return docs.map(doc => ({
            docId: doc.doc_id,
            title: doc.title,
            metadata: JSON.parse(doc.metadata || '{}'),
            chunkCount: doc.chunk_count,
            createdAt: doc.created_at
        }));
    } catch (error) {
        console.error('[AI][KB] List documents failed:', error?.message || error);
        throw error;
    }
}

/**
 * Chunk text into smaller pieces for embedding
 * Tries to split on paragraph/sentence boundaries
 * 
 * @param {string} text - Text to chunk
 * @param {number} [maxChars=3800] - Max characters per chunk
 * @returns {string[]} Array of text chunks
 */
function chunkText(text, maxChars = 3800) {
    const cleanText = String(text || '').replace(/\r/g, '').trim();
    const chunks = [];
    let i = 0;

    while (i < cleanText.length) {
        let end = Math.min(i + maxChars, cleanText.length);

        if (end < cleanText.length) {
            const slice = cleanText.slice(i, end);

            // Try to split on paragraph boundary
            let cutPoint = slice.lastIndexOf('\n\n');

            // If no paragraph, try sentence
            if (cutPoint < maxChars * 0.5) {
                cutPoint = Math.max(cutPoint, slice.lastIndexOf('. '));
            }

            // If no sentence, try any space
            if (cutPoint < maxChars * 0.5) {
                cutPoint = Math.max(cutPoint, slice.lastIndexOf(' '));
            }

            // Use the cut point if it's reasonable
            if (cutPoint >= maxChars * 0.5) {
                end = i + cutPoint + 1;
            }
        }

        const chunk = cleanText.slice(i, end).trim();
        if (chunk) {
            chunks.push(chunk);
        }

        i = end;
    }

    return chunks;
}

module.exports = {
    addDocument,
    searchKnowledgeBase,
    deleteDocument,
    listDocuments,
    chunkText
};
