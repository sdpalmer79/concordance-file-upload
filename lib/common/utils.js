
const DATE_REGEXP = /^(-?(?:[1-9][0-9]*)?[0-9]{4})-(1[0-2]|0[1-9])-(3[01]|0[1-9]|[12][0-9])T(2[0-3]|[01][0-9]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?(Z)?$/;

module.exports = {
    createError: (msg, params) => {
        const error = new Error(msg);
        error.params = params;
        return error;
    },
    isISODate: (text) => {
        return DATE_REGEXP.test(text);
    },
    createEnum: (values) => {
        const enumObject = {};
        for (const val of values) {
            enumObject[val] = val;
        }
        return Object.freeze(enumObject);
    }
}
