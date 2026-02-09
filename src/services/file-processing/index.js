const pdf = require('./pdf-parser');
const excel = require('./excel-parser');
const doc = require('./doc-parser');
const chatgpt = require('./chatgpt-export');
const media = require('./media-handler');

module.exports = {
    ...pdf,
    ...excel,
    ...doc,
    ...chatgpt,
    ...media
};
