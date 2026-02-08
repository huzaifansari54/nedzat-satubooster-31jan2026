/**
 * AI Embeddings Service
 * Handles text embeddings generation using OpenAI
 */

const OpenAI = require('openai');

/**
 * Generate text embedding using OpenAI
 * Uses text-embedding-3-small model for cost-effectiveness
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string} text - Text to embed
 * @param {object} options - Additional options
 * @param {string} [options.model='text-embedding-3-small'] - Embedding model to use
 * @returns {Promise<number[]>} Embedding vector
 * @throws {Error} If embedding generation fails
 */
async function generateEmbedding(apiKey, text, options = {}) {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('OpenAI API key is required');
    }

    if (!text || !text.trim()) {
        throw new Error('Text is required for embedding');
    }

    const model = options.model || 'text-embedding-3-small';

    try {
        const openai = new OpenAI({ apiKey: apiKey.trim() });

        const response = await openai.embeddings.create({
            model,
            input: text.trim()
        });

        const embedding = response.data?.[0]?.embedding || [];

        if (!embedding || embedding.length === 0) {
            throw new Error('Empty embedding returned from OpenAI');
        }

        return embedding;
    } catch (error) {
        console.error('[AI][EMBEDDINGS] Generation failed:', error?.message || error);
        throw error;
    }
}

/**
 * Generate embeddings for multiple texts (batch)
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {string[]} texts - Array of texts to embed
 * @param {object} options - Additional options
 * @param {string} [options.model='text-embedding-3-small'] - Embedding model to use
 * @returns {Promise<number[][]>} Array of embedding vectors
 * @throws {Error} If embedding generation fails
 */
async function generateEmbeddingsBatch(apiKey, texts, options = {}) {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('OpenAI API key is required');
    }

    if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error('Texts array is required for batch embedding');
    }

    const model = options.model || 'text-embedding-3-small';

    try {
        const openai = new OpenAI({ apiKey: apiKey.trim() });

        const response = await openai.embeddings.create({
            model,
            input: texts.map(t => String(t || '').trim()).filter(Boolean)
        });

        return response.data.map(item => item.embedding);
    } catch (error) {
        console.error('[AI][EMBEDDINGS] Batch generation failed:', error?.message || error);
        throw error;
    }
}

/**
 * Calculate cosine similarity between two embedding vectors
 * Used for semantic search and similarity matching
 * 
 * @param {number[]} vec1 - First embedding vector
 * @param {number[]} vec2 - Second embedding vector
 * @returns {number} Similarity score between -1 and 1 (higher is more similar)
 */
function cosineSimilarity(vec1, vec2) {
    if (!Array.isArray(vec1) || !Array.isArray(vec2)) {
        throw new Error('Both arguments must be arrays');
    }

    if (vec1.length !== vec2.length) {
        throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
    }

    const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);

    if (magnitude === 0) {
        return 0;
    }

    return dotProduct / magnitude;
}

module.exports = {
    generateEmbedding,
    generateEmbeddingsBatch,
    cosineSimilarity
};
