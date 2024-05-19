const logger = require('../common/logging');
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
const symbolsSchema = require('../schemas/symbols.schema.json');
ajv.addSchema(wordsSchema, 'wordsSchema');
ajv.addSchema(symbolsSchema, 'symbolsSchema');

let queuedProcessRoots = 0;

async function enqueueProcessRoots() {
    queuedProcessRoots++;
    if (queuedProcessRoots === 1) {
        while (queuedProcessRoots) {
            try {
                await processRoots();
            } catch (error) {
                logger.error(`Error processing roots: ${error.message}`);
            }
            queuedProcessRoots--;
        }
    }
}

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
        await sleep(10000);
    }
}

async function parseWordsFile (fileStream, logger = logger) {
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
    await mongo.getWordsCollection().insertMany(words);
    enqueueProcessRoots();
}

async function parseSymbolsFile (fileStream, logger = logger, args = []) {
    const symbols = await new Promise((resolve, reject) => 
            Papa.parse(fileStream, {
                header: true,
                transformHeader:function(h) {
                    return h.trim();
                },
                transform: function(value, columnName) {
                    if (['chapter','verse'].includes(columnName)) {
                        const intValue = parseInt(value);
                        return Number.isInteger(intValue) ? intValue : null;
                    }
                    return value;
                },
                complete: function(results) {
                    for (let word of results.data) {
                        if (!ajv.validate(symbolsSchema, word)) {
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
    const bookNum = parseInt(args[0]).toString().padStart(2, '0');
    const updates = [];
    symbols.reduce((prevId, entry) => {
        
        //get previous entries chapter, verse and wordCount
        let chapter = parseInt(prevId.substring(3, 6));
        let verse = parseInt(prevId.substring(6, 9));
        let wordCount = parseInt(prevId.substring(9));
        
        //update if needed
        if (entry.chapter !== null) {
            chapter = entry.chapter
        }
        if (entry.verse !== null) {
            verse = entry.verse
            wordCount = 0;
        }
        
        //compute _id,word
        const _id = `1${bookNum}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}${(++wordCount).toString().padStart(2, '0')}`;
        const word = entry.wordWithSymbols.match(/[\u05d0-\u05ea]/g)?.join('');
        
        //prepare and call bulkWrite
        updates.push({
            updateOne: {
                filter: {  _id, word },
                update: { $set: { wordWithSymbols: entry.wordWithSymbols } }
            }
        });
        return _id;
    }, `1${bookNum}00000000`);
    const result = await mongo.getWordsCollection().bulkWrite(updates);
    logger.info(`Bulk write result: ${result.modifiedCount} documents modified`);
}

async function parseFile (path, func, logger = logger, args = []) {
    try {
        const fileStream = fs.createReadStream(path);
        await func(fileStream, logger, args);
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
    postWordFile: async (req, res) => {
        try {
            if (!await checkHealth()) {
                res.status(503).end('Service is not healthy');
            } else if (!req.file?.path) {
                res.status(400).end('Content-type must be multipart/form-data and file name must be \'file\'');
            } else {
                await parseFile(req.file.path, parseWordsFile, req.logger)
                res.status(200).end('File parsed successfully');
            }
        } catch (error) {
            req.logger.error(error.message);
            const status = error.params?.httpStatus || 500;
            res.status(status);
            res.end(status === 400 ? error.message : '');
        }
    },
    postSymbolsFile: async (req, res) => {
        try {
            if (!await checkHealth()) {
                res.status(503).end('Service is not healthy');
            } else if (!req.file?.path) {
                res.status(400).end('Content-type must be multipart/form-data and file name must be \'file\'');
            } else if (!req.body?.book_num) {
                res.status(400).end('multipart/form-data must contain key \'book_num\'');
            } else if (!Number.isInteger(parseInt(req.body.book_num))) {
                res.status(400).end('\'book_num\' must be an integer');
            }  else {
                await parseFile(req.file.path, parseSymbolsFile, req.logger, [req.body.book_num])
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

