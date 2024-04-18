const { createError } = require('../common/utils');
const { getQueryParams } = require('./queryParamUtils');
const { checkHealth } = require('../common/healthCheck');
const mongo = require('../storage/mongo');
const Papa = require('papaparse');
const fs = require('fs');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

const wordsSchema = require('../schemas/words.schema.json');
ajv.addSchema(wordsSchema, 'articleContentSchema');

async function parseWordsFile (path, logger) {
    try {
        const fileStream = fs.createReadStream(path);
        const words = await new Promise((resolve, reject) => 
            Papa.parse(fileStream, {
                header: true,
                complete: function(results) {
                    for (let word of results.data) {
                        if (!ajv.validate(wordsSchema, word)) {
                            throw createError(`Invalid file. Schema validation failed for word: ${ajv.errorsText()}`, { httpStatus: 400});
                        }     
                    }
                    resolve(results.data);
                },
                error: function (error) {
                    reject(error);
                }
            })
        );
        mongo.getWordsCollection().insertMany(words);
    }
    catch (error) {
        throw error;
    }
    finally {
        fs.unlink(path, (error) => {
            if (error) {
                logger.error(`Error deleting file: ${error}`);
            }
        });
    }
} 

module.exports = {
    getTest: async (req, res) => {
        try {
            if (!await checkHealth()) {
                res.status(503);
                res.end('Service is not healthy')
            } else {
                const {test_param} = getQueryParams(req);
                res.status(200);
                res.end(`Service is healthy. test_param = ${test_param}`);
            }
        } catch (error) {
            req.logger.error(error.message);
            res.status(error.params?.httpStatus || 500);
            res.end();
        }
    },
    postFile: async (req, res) => {
        try {
            //if (!await checkHealth()) {
            //    res.status(503).end('Service is not healthy');
            //} else 
            if (!req.file?.path) {
                res.status(400).end('Content-type must be multipart/form-data and file name must be \'file\'');
            } else {
                await parseWordsFile(req.file.path, req.logger)
                res.status(200).end('File parsed successfully');
            }
        } catch (error) {
            req.logger.error(error.message);
            const status = error.params?.httpStatus || 500;
            res.status(status);
            res.end(status === 400 ? error.message : '');
        }
    }
};

