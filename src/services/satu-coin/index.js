const wallet = require('./wallet');
const leads = require('./leads');
const transactions = require('./transactions');

module.exports = {
    ...wallet,
    ...leads,
    ...transactions
};
