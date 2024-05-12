const { createError, sleep } = require('../common/utils');
const { getQueryParams } = require('./queryParamUtils');
const { checkHealth } = require('../common/healthCheck');
const mongo = require('../storage/mongo');
const Papa = require('papaparse');
const fs = require('fs');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });
const got = require('got');
const parse = require('node-html-parser').parse;

const wordsSchema = require('../schemas/words.schema.json');
ajv.addSchema(wordsSchema, 'articleContentSchema');

async function processRoots() {
    const cursor = mongo.getWordsCollection().find({ rootId: { $exists: false } });
    while(await cursor.hasNext()) {
        const wordEntry = await cursor.next();
        const response = await got(`https://www.pealim.com/search/?q=${wordEntry.word}`);
        const element = parse(response.body).querySelector('.verb-search-root');

        const hebrewLetters = element?.text?.match(/[\u05d0-\u05ea]/g);
        if (hebrewLetters?.length > 0) {
            const root = hebrewLetters.join('');
            const rootEntry = await mongo.getRootsCollection().findOneAndUpdate(
                { root }, //filter
                { $setOnInsert: { root }, $addToSet: { wordIds: wordEntry._id } }, //update
                { upsert: true, returnNewDocument: true } //options
            );
            await mongo.getWordsCollection().findOneAndUpdate({ _id: wordEntry._id }, { $set: { rootId: rootEntry._id }});
        }
        sleep(5000);
      }
}

async function parseWordsFile (path, logger) {
    try {
        const fileStream = fs.createReadStream(path);
        const words = await new Promise((resolve, reject) => 
            Papa.parse(fileStream, {
                header: true,
                transform: function(value, columnName) {
                    if (['book', 'chapter','verse','wordCount'].includes(columnName)) {
                        return parseInt(value);
                    }
                    return value;
                },
                complete: function(results) {
                    for (let word of results.data) {
                        if (!ajv.validate(wordsSchema, word)) {
                            throw createError(`Invalid file. Schema validation failed for word ${JSON.stringify(word)}: ${ajv.errorsText()}`, { httpStatus: 400});
                        }  
                    }
                    resolve(results.data);
                },
                error: function (error) {
                    reject(error);
                }
            })
        );
        processRoots();
        await mongo.getWordsCollection().insertMany(words);
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
            if (!await checkHealth()) {
                res.status(503).end('Service is not healthy');
            } else if (!req.file?.path) {
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

