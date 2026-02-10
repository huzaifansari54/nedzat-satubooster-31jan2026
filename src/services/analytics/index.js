const geo = require('./geo-parser');
const visitor = require('./visitor-tracking');

module.exports = {
    ...geo,
    ...visitor
};
