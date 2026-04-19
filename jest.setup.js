const util = require('util');
if (!util.isString) {
    util.isString = function (value) {
        return typeof value === 'string';
    };
}
if (!util.isNumber) {
    util.isNumber = function (value) {
        return typeof value === 'number';
    };
}

// Set test database type so entities can use conditional column types
process.env.DB_TYPE = 'sqlite';
