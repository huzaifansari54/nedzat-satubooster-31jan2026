/**
 * AI Chat Service
 * Handles chat completions using OpenAI models
 */

const OpenAI = require('openai');

/**
 * Generate chat completion using OpenAI
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {object} params - Chat parameters
 * @param {Array} params.messages - Array of message objects {role, content}
 * @param {string} [params.model='gpt-4o'] - Model to use
 * @param {number} [params.temperature=0.7] - Temperature (0-2)
 * @param {number} [params.maxTokens=200] - Max tokens to generate
 * @param {string} [params.user] - User identifier for tracking
 * @returns {Promise<object>} Chat completion response with message, usage, and cost
 * @throws {Error} If chat completion fails
 */
async function generateChatCompletion(apiKey, params) {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('OpenAI API key is required');
    }

    if (!params.messages || !Array.isArray(params.messages) || params.messages.length === 0) {
        throw new Error('Messages array is required');
    }

    const model = params.model || 'gpt-4o';
    const temperature = params.temperature !== undefined ? params.temperature : 0.7;
    const maxTokens = params.maxTokens || 200;

    try {
        const openai = new OpenAI({ apiKey: apiKey.trim() });

        const requestParams = {
            model,
            messages: params.messages,
            temperature,
            max_tokens: maxTokens
        };

        if (params.user) {
            requestParams.user = params.user;
        }

        const response = await openai.chat.completions.create(requestParams);

        const message = response.choices?.[0]?.message;
        const usage = response.usage;

        if (!message) {
            throw new Error('No message in OpenAI response');
        }

        return {
            message: {
                role: message.role,
                content: message.content
            },
            usage: {
                promptTokens: usage?.prompt_tokens || 0,
                completionTokens: usage?.completion_tokens || 0,
                totalTokens: usage?.total_tokens || 0
            },
            model: response.model,
            finishReason: response.choices?.[0]?.finish_reason
        };
    } catch (error) {
        console.error('[AI][CHAT] Completion failed:', error?.message || error);
        throw error;
    }
}

/**
 * Generate streaming chat completion
 * 
 * @param {string} apiKey - OpenAI API key
 * @param {object} params - Chat parameters
 * @param {Array} params.messages - Array of message objects {role, content}
 * @param {string} [params.model='gpt-4o'] - Model to use
 * @param {number} [params.temperature=0.7] - Temperature (0-2)
 * @param {number} [params.maxTokens=200] - Max tokens to generate
 * @param {Function} params.onChunk - Callback for each chunk (chunk) => void
 * @returns {Promise<object>} Final completion with full message and usage
 * @throws {Error} If streaming fails
 */
async function generateChatCompletionStream(apiKey, params) {
    if (!apiKey || !apiKey.trim()) {
        throw new Error('OpenAI API key is required');
    }

    if (!params.messages || !Array.isArray(params.messages) || params.messages.length === 0) {
        throw new Error('Messages array is required');
    }

    if (!params.onChunk || typeof params.onChunk !== 'function') {
        throw new Error('onChunk callback is required for streaming');
    }

    const model = params.model || 'gpt-4o';
    const temperature = params.temperature !== undefined ? params.temperature : 0.7;
    const maxTokens = params.maxTokens || 200;

    try {
        const openai = new OpenAI({ apiKey: apiKey.trim() });

        const stream = await openai.chat.completions.create({
            model,
            messages: params.messages,
            temperature,
            max_tokens: maxTokens,
            stream: true
        });

        let fullContent = '';
        let finishReason = null;

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta;
            const content = delta?.content || '';

            if (content) {
                fullContent += content;
                params.onChunk(content);
            }

            if (chunk.choices?.[0]?.finish_reason) {
                finishReason = chunk.choices[0].finish_reason;
            }
        }

        return {
            message: {
                role: 'assistant',
                content: fullContent
            },
            model,
            finishReason
        };
    } catch (error) {
        console.error('[AI][CHAT] Streaming failed:', error?.message || error);
        throw error;
    }
}

/**
 * Calculate rough token count for text
 * Uses simple heuristic: ~4 characters per token
 * 
 * @param {string} text - Text to estimate tokens for
 * @returns {number} Estimated token count
 */
function estimateTokenCount(text) {
    return Math.ceil(String(text || '').length / 4);
}

/**
 * Calculate cost for OpenAI API usage
 * 
 * @param {string} model - Model name
 * @param {number} promptTokens - Input tokens
 * @param {number} completionTokens - Output tokens
 * @param {object} pricing - Pricing object {model: {in: price, out: price}}
 * @returns {object} Cost breakdown {in, out, total, known}
 */
function calculateCost(model, promptTokens, completionTokens, pricing = {}) {
    const modelKey = String(model || '').trim();
    const priceData = pricing[modelKey] || pricing['*'];

    if (!priceData || (!priceData.in && !priceData.out)) {
        return { in: 0, out: 0, total: 0, known: false };
    }

    // Prices are in USD per 1,000,000 tokens
    const inputCost = (Number(promptTokens || 0) / 1_000_000) * Number(priceData.in || 0);
    const outputCost = (Number(completionTokens || 0) / 1_000_000) * Number(priceData.out || 0);
    const totalCost = inputCost + outputCost;

    return {
        in: inputCost,
        out: outputCost,
        total: totalCost,
        known: true
    };
}

module.exports = {
    generateChatCompletion,
    generateChatCompletionStream,
    estimateTokenCount,
    calculateCost
};
