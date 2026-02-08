/**
 * AI Prompts Service
 * Manages system prompts and prompt templates for AI interactions
 */

/**
 * Default system prompts for different channels
 */
const DEFAULT_PROMPTS = {
    whatsapp: 'Ты вежливый WhatsApp-ассистент. Отвечай кратко, дружелюбно и по делу.',
    instagram: 'Ты вежливый Instagram-ассистент. Отвечай кратко, дружелюбно и по делу.',
    telegram: 'Ты вежливый Telegram-ассистент. Отвечай кратко, дружелюбно и по делу.',
    general: 'Ты вежливый ассистент. Отвечай кратко, дружелюбно и по делу.'
};

/**
 * Build system prompt with context
 * 
 * @param {object} params - Prompt parameters
 * @param {string} [params.basePrompt] - Base system prompt
 * @param {string} [params.channel='general'] - Channel type (whatsapp, instagram, telegram)
 * @param {string} [params.businessContext] - Business-specific context
 * @param {Array} [params.knowledgeChunks] - Knowledge base chunks for RAG
 * @param {object} [params.userInfo] - User information
 * @returns {string} Complete system prompt
 */
function buildSystemPrompt(params = {}) {
    const {
        basePrompt,
        channel = 'general',
        businessContext,
        knowledgeChunks = [],
        userInfo = {}
    } = params;

    const parts = [];

    // Base prompt
    const base = basePrompt || DEFAULT_PROMPTS[channel] || DEFAULT_PROMPTS.general;
    parts.push(base);

    // Business context
    if (businessContext && businessContext.trim()) {
        parts.push('\n\n**Контекст бизнеса:**');
        parts.push(businessContext.trim());
    }

    // Knowledge base context (RAG)
    if (knowledgeChunks.length > 0) {
        parts.push('\n\n**Информация из базы знаний:**');
        knowledgeChunks.forEach((chunk, index) => {
            parts.push(`\n${index + 1}. ${chunk.text}`);
        });
        parts.push('\n\nИспользуй эту информацию для ответа, если она релевантна вопросу.');
    }

    // User info
    if (userInfo.name || userInfo.phone || userInfo.email) {
        parts.push('\n\n**Информация о клиенте:**');
        if (userInfo.name) parts.push(`Имя: ${userInfo.name}`);
        if (userInfo.phone) parts.push(`Телефон: ${userInfo.phone}`);
        if (userInfo.email) parts.push(`Email: ${userInfo.email}`);
    }

    return parts.join('\n');
}

/**
 * Build conversation history for chat completion
 * Formats messages with proper roles and content
 * 
 * @param {Array} messages - Array of message objects
 * @param {number} [maxMessages=12] - Maximum messages to include
 * @returns {Array} Formatted messages for OpenAI
 */
function buildConversationHistory(messages, maxMessages = 12) {
    if (!Array.isArray(messages)) {
        return [];
    }

    // Take last N messages
    const recentMessages = messages.slice(-maxMessages);

    return recentMessages.map(msg => ({
        role: msg.role || (msg.from_me ? 'assistant' : 'user'),
        content: msg.content || msg.text || ''
    })).filter(msg => msg.content.trim());
}

/**
 * Build complete message array for chat completion
 * Includes system prompt and conversation history
 * 
 * @param {object} params - Parameters
 * @param {string} params.systemPrompt - System prompt
 * @param {Array} params.conversationHistory - Conversation messages
 * @param {string} params.userMessage - Current user message
 * @returns {Array} Complete messages array for OpenAI
 */
function buildChatMessages(params) {
    const {
        systemPrompt,
        conversationHistory = [],
        userMessage
    } = params;

    const messages = [];

    // System prompt
    if (systemPrompt && systemPrompt.trim()) {
        messages.push({
            role: 'system',
            content: systemPrompt.trim()
        });
    }

    // Conversation history
    if (Array.isArray(conversationHistory)) {
        messages.push(...conversationHistory);
    }

    // Current user message
    if (userMessage && userMessage.trim()) {
        messages.push({
            role: 'user',
            content: userMessage.trim()
        });
    }

    return messages;
}

/**
 * Template for follow-up messages
 * 
 * @param {object} params - Template parameters
 * @param {string} params.customerName - Customer name
 * @param {string} params.productService - Product/service name
 * @param {string} [params.customMessage] - Custom follow-up message
 * @returns {string} Follow-up message
 */
function buildFollowUpMessage(params) {
    const { customerName, productService, customMessage } = params;

    if (customMessage && customMessage.trim()) {
        return customMessage.trim();
    }

    const name = customerName ? `${customerName}, ` : '';
    const product = productService || 'наше предложение';

    return `Здравствуйте${name ? ', ' + name : ''}! Напоминаем о ${product}. Есть вопросы?`;
}

/**
 * Template for escalation messages
 * 
 * @param {object} params - Template parameters
 * @param {string} params.reason - Escalation reason
 * @param {string} params.customerName - Customer name
 * @param {string} params.customerPhone - Customer phone
 * @returns {string} Escalation notification message
 */
function buildEscalationMessage(params) {
    const { reason, customerName, customerPhone } = params;

    const parts = ['🔔 Требуется внимание оператора'];

    if (reason) {
        parts.push(`Причина: ${reason}`);
    }

    if (customerName) {
        parts.push(`Клиент: ${customerName}`);
    }

    if (customerPhone) {
        parts.push(`Телефон: ${customerPhone}`);
    }

    return parts.join('\n');
}

/**
 * Template for moderation warning
 * 
 * @param {object} params - Template parameters
 * @param {string} [params.language='ru'] - Language (ru/en)
 * @returns {string} Moderation warning message
 */
function buildModerationWarning(params = {}) {
    const { language = 'ru' } = params;

    if (language === 'en') {
        return 'Your message contains inappropriate content. Please be respectful.';
    }

    return 'Ваше сообщение содержит недопустимый контент. Пожалуйста, будьте вежливы.';
}

/**
 * Template for out-of-hours message
 * 
 * @param {object} params - Template parameters
 * @param {string} [params.workHours] - Working hours description
 * @param {string} [params.language='ru'] - Language (ru/en)
 * @returns {string} Out-of-hours message
 */
function buildOutOfHoursMessage(params = {}) {
    const { workHours, language = 'ru' } = params;

    if (language === 'en') {
        const hours = workHours || 'during business hours';
        return `Thank you for your message! We're currently offline. We'll respond ${hours}.`;
    }

    const hours = workHours || 'в рабочее время';
    return `Спасибо за сообщение! Мы сейчас не в сети. Ответим ${hours}.`;
}

module.exports = {
    DEFAULT_PROMPTS,
    buildSystemPrompt,
    buildConversationHistory,
    buildChatMessages,
    buildFollowUpMessage,
    buildEscalationMessage,
    buildModerationWarning,
    buildOutOfHoursMessage
};
