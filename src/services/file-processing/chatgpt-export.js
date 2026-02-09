/**
 * Flattens a ChatGPT JSON export into a readable text format.
 * @param {Array|Object} exportJson - The JSON data from ChatGPT export
 * @returns {string} Readable conversation text
 */
function flattenChatGptExport(exportJson) {
    const arr = Array.isArray(exportJson) ? exportJson : [];
    const out = [];

    for (const conv of arr) {
        if (!conv) continue;

        const title = String(conv.title || 'Untitled').trim();
        const created = conv.create_time ? new Date(conv.create_time * 1000) : null;

        const headerParts = ['==== Dialogue: ' + title];
        if (created) {
            headerParts.push('(' + created.toLocaleString('ru-RU') + ')');
        }
        out.push(headerParts.join(' ') + ' ====');

        const mapping = conv.mapping || {};
        const nodes = Object.values(mapping)
            .filter(n => n && n.message && n.message.content)
            .sort((a, b) => {
                const ta = (a.message && a.message.create_time) ? a.message.create_time : 0;
                const tb = (b.message && b.message.create_time) ? b.message.create_time : 0;
                return ta - tb;
            });

        for (const node of nodes) {
            const m = node.message;
            if (!m) continue;

            const ts = m.create_time
                ? new Date(m.create_time * 1000).toLocaleString('ru-RU')
                : '';

            let role = (m.author && m.author.role) ? m.author.role : 'unknown';
            if (role === 'assistant') role = 'ChatGPT';
            else if (role === 'user') role = 'User'; // Translated from Russian 'Пользователь' to keep it consistent
            else if (role === 'system') role = 'System';

            let text = '';
            const c = m.content;
            if (c) {
                if (Array.isArray(c.parts)) {
                    text = c.parts.join('\n');
                } else if (typeof c === 'string') {
                    text = c;
                } else if (c.text) {
                    text = c.text;
                }
            }
            if (!String(text || '').trim()) continue;

            out.push((ts ? '[' + ts + '] ' : '') + role + ':\n' + text + '\n');
        }

        out.push('');
    }

    return out.join('\n');
}

module.exports = {
    flattenChatGptExport
};
