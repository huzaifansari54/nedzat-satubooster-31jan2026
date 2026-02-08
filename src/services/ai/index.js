/**
 * AI Service
 * Main export for AI and OpenAI integration services
 * 
 * This service handles:
 * - Chat completions (standard and streaming)
 * - Text embeddings generation
 * - Knowledge base (RAG) operations
 * - Prompt templates and system prompts
 * - Token counting and cost calculation
 * 
 * @module services/ai
 */

const chat = require('./chat');
const embeddings = require('./embeddings');
const knowledgeBase = require('./knowledge-base');
const prompts = require('./prompts');

module.exports = {
    // Chat Completions
    generateChatCompletion: chat.generateChatCompletion,
    generateChatCompletionStream: chat.generateChatCompletionStream,
    estimateTokenCount: chat.estimateTokenCount,
    calculateCost: chat.calculateCost,

    // Embeddings
    generateEmbedding: embeddings.generateEmbedding,
    generateEmbeddingsBatch: embeddings.generateEmbeddingsBatch,
    cosineSimilarity: embeddings.cosineSimilarity,

    // Knowledge Base (RAG)
    addDocument: knowledgeBase.addDocument,
    searchKnowledgeBase: knowledgeBase.searchKnowledgeBase,
    deleteDocument: knowledgeBase.deleteDocument,
    listDocuments: knowledgeBase.listDocuments,
    chunkText: knowledgeBase.chunkText,

    // Prompts & Templates
    DEFAULT_PROMPTS: prompts.DEFAULT_PROMPTS,
    buildSystemPrompt: prompts.buildSystemPrompt,
    buildConversationHistory: prompts.buildConversationHistory,
    buildChatMessages: prompts.buildChatMessages,
    buildFollowUpMessage: prompts.buildFollowUpMessage,
    buildEscalationMessage: prompts.buildEscalationMessage,
    buildModerationWarning: prompts.buildModerationWarning,
    buildOutOfHoursMessage: prompts.buildOutOfHoursMessage
};
