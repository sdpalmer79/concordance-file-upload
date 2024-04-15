const { getQueryParams } = require('./queryParamUtils');
const { checkHealth } = require('../common/healthCheck');
const mongo = require('../storage/mongo');
const { ObjectId } = require("mongodb");

module.exports = {
    getTest: async (req, res) => {
        try {
            if (!await checkHealth()) {
                res.status(503);
                res.end('Service is not healthy')
            } else {
                res.status(200);
                res.end('Service is healthy');
            }
        } catch (error) {
            req.logger.error(error.message);
            res.status(error.params?.httpStatus || 500);
            res.end();
        }
    }
};

