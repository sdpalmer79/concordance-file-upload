
const OpenAI= require('openai');
const openAI = new OpenAI();
const parse = require('node-html-parser').parse;
const mongo = require('../storage/mongo');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DATE_REGEXP = /^(-?(?:[1-9][0-9]*)?[0-9]{4})-(1[0-2]|0[1-9])-(3[01]|0[1-9]|[12][0-9])T(2[0-3]|[01][0-9]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?(Z)?$/;

const partOfSpeechSchema = require('../schemas/partOfSpeech.schema.json');
ajv.addSchema(partOfSpeechSchema, 'partOfSpeechSchema');

function getId(book, chapter, verse, wordCount) {
    return `1${book}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}${(wordCount).toString().padStart(2, '0')}`;
}

async function chatCompletionsCreate(messages, schemaName, temperature = 0.5, maxTokens = 999) {
    const response = await openAI.chat.completions.create({
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        response_format: {'type': 'json_object'},
        model: OPENAI_MODEL
    });
    const json = JSON.parse(response?.choices[0]?.message?.content);
    if (!ajv.validate(schemaName, json)) {
        throw new Error(`Invalid response from OpenAI. Schema validation failed for messsage ${JSON.stringify(messages)} with errors: ${ajv.errorsText()}`);
    }
    return json;
}

async function getSentenceCursor() {
    //find a word with no partOfSpeech
    const wordEntry = await mongo.getWordsCollection().findOne({$or: [{ partOfSpeech: { $exists: false }}, { translation: { $exists: false }}]});
    if (!wordEntry) {
        return null;
    }
    //retrieve all words in the sentence since each part of speech requires context
    let { book, chapter, verse } = wordEntry;
    return await mongo.getWordsCollection().find({ book, chapter, verse}).sort({ wordCount: 1 });
}

async function incSentenceCursor(book = 1, chapter = 1, verse = 0) {
    let cursor = findSentence(book, chapter, ++verse);
    if (!cursor.hasNext()) {
        cursor = findSentence(book, ++chapter, 1);
    }
    if (!cursor.hasNext()) {
        cursor = findSentence(++book, 1, 1);
    }
    return cursor.hasNext() ? cursor : null;
}

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
    },
    sleep: async (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    processRoots: async () => {
        const cursor = mongo.getWordsCollection().find({ rootId: { $exists: false }, partOfSpeech: { $in: ['noun', 'verb']} });
        while(await cursor.hasNext()) {
            const wordEntry = await cursor.next();
            const response = await got(`https://www.pealim.com/search/?q=${wordEntry.word}`);
            
            const elements = parse(response.body).querySelectorAll('.verb-search-result');
            const element = elements.find((element) => {
                const menukadElements = parse(element).querySelectorAll('.menukad');
                return menukadElements.find((menukadElement) => {
                    const wordWithNikud = wordEntry.wordWithSymbols.match(/[\u05b0-\u05ea]/g)?.join('');
                    if (wordWithNikud?.length > 0)
                        return menukadElement?.text === wordWithNikud;
                });
            });
    
            const rootElement = parse(element).querySelector('.verb-search-root');
            const hebrewLetters = rootElement?.text?.match(/[\u05d0-\u05ea]/g);
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
    },
    processPartOfSpeech: async () => {
        const messages = [{'role': 'system', 'content': `You are a helpful assistant.`},
                    {'role': 'user', 'content': 'Break down the following sentence into parts of speech.'},
                    {'role': 'user', 'content': 'The response must be JSON array named partsOfSpeech.'},
                    {'role': 'user', 'content': 'Each element in the array is an object with 3 fields: word, partOfSpeech and translation.'},
                    {'role': 'user', 'content': 'partOfSpeech is an array that contains all parts of speech for a single word.'},
                    {'role': 'user', 'content': 'partOfSpeech can be a noun, verb, adjective, adverb, preposition or conjunction'},
                    {'role': 'user', 'content': 'All text must lowercase.'},
                    {}
                ];
        let cursor = await getSentenceCursor();
        while (cursor) {
            let wordEntrys =[];
            while (await cursor.hasNext()) {
                wordEntrys.push(await cursor.next());
            }
            
            //add sentence to messages
            messages.pop();
            messages.push({'role': 'user', 'content': wordEntrys.map((wordEntry) => wordEntry.wordWithSymbols).join(' ')});
            
            //get breakdown to parts of speech from OpenAI
            const { partsOfSpeech } = await chatCompletionsCreate(messages,'partOfSpeechSchema');
            for (let i = 0;i < partsOfSpeech.length;i++) {
                if (partsOfSpeech[i].word !== wordEntrys[i].wordWithSymbols) {
                    throw new Error(`Invalid response from OpenAI. Expected ${wordEntrys[i].wordWithSymbols} but got ${partsOfSpeech[i].word}. ${JSON.stringify(partsOfSpeech[i])} ${JSON.stringify(wordEntrys[i])}`);
                }

                //update mongo
                await mongo.getWordsCollection().findOneAndUpdate(
                    { _id: wordEntrys[i]._id }, 
                    { $set: { partOfSpeech: partsOfSpeech[i].partOfSpeech, translation: partsOfSpeech[i].translation } },
                );
            }
            cursor = await getSentenceCursor();
        }
    }
}