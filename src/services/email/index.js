const mailer = require('./mailer');
const templates = require('./templates');

module.exports = {
    ...mailer,
    ...templates
};
