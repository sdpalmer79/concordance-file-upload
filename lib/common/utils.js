const OpenAI = require('openai');
const openAI = new OpenAI();
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
const parse = require('node-html-parser').parse;
const mongo = require('../storage/mongo');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });
const got = require('got');
const mainLogger = require('../common/logging');

const AI_API = process.env.AI_API;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620';
const DATE_REGEXP = /^(-?(?:[1-9][0-9]*)?[0-9]{4})-(1[0-2]|0[1-9])-(3[01]|0[1-9]|[12][0-9])T(2[0-3]|[01][0-9]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?(Z)?$/;

const partOfSpeechSchema = require('../schemas/partOfSpeech.schema.json');
ajv.addSchema(partOfSpeechSchema, 'partOfSpeechSchema');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function anthropicMessagesCreate(system, prompt, schemaName, temperature = 0.1, maxTokens = 999, logger = mainLogger) {
    const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [
          {
            "role": "user",
            "content": [
              {
                "type": "text",
                "text": prompt
              }
            ]
          }
        ]
      });
    logger.info(`Anthropic messages create returned: ${response.content[0].text}`);
    const json = JSON.parse(response.content[0].text);
    if (!ajv.validate(schemaName, json)) {
        throw new Error(`Invalid response from AnthropicAI. Schema validation failed. AJV errors: ${ajv.errorsText()}. messages: ${JSON.stringify(prompt)}.\n `);
    }
    return json;
}

async function openAichatCompletionsCreate(system, messages, schemaName, temperature = 0.1, maxTokens = 999, logger = mainLogger) {
    const response = await openAI.chat.completions.create({
        messages: [
            {'role': 'system', 'content': system },
            {'role': 'user', 'content': messages }
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: {'type': 'json_object'},
        model: OPENAI_MODEL
    });
    logger.info(`OpenAI chat completions returned: ${response?.choices[0]?.message?.content}`);
    const json = JSON.parse(response?.choices[0]?.message?.content);
    if (!ajv.validate(schemaName, json)) {
        throw new Error(`Invalid response from OpenAI. Schema validation failed. AJV errors: ${ajv.errorsText()}. messages: ${JSON.stringify(messages)}.\n `);
    }
    return json;
}

async function callAiApi(system, messages, schemaName, temperature = 0.1, maxTokens = 999, logger = mainLogger) {
    let functionToCall;
    if ( AI_API === 'ANTHROPIC') {
        functionToCall = anthropicMessagesCreate;
    } else if ( AI_API === 'OPEN_AI' ) {
        functionToCall = openAichatCompletionsCreate;
    } else {
        throw new Error(`Unsupported AI_API: ${AI_API}`);
    }
    return await functionToCall(system, messages, schemaName, temperature, maxTokens, logger);
}

async function getSentenceCursor(logger = mainLogger) {
    //find a word with no partOfSpeech
    const wordEntry = await mongo.getWordsCollection().findOne({$or: [{ components: { $exists: false }}, { translation: { $exists: false }}]});
    if (!wordEntry) {
        return null;
    }
    //retrieve all words in the sentence since each part of speech requires context
    logger.info(`Found word missing components or translation: ${JSON.stringify(wordEntry)}`);
    let { book, chapter, verse } = wordEntry;
    return await mongo.getWordsCollection().find({ book, chapter, verse}).sort({ wordCount: 1 });
}

function areAllCharsContained(stringA, stringB) {
    return stringA.split('').every(char => stringB.includes(char));
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
    sleep: async (ms) => sleep(ms),
    processRoots: async () => {
        mainLogger.info('processRoots started');
        const cursor = mongo.getWordsCollection().find({ rootId: { $exists: false }, "components.partsOfSpeech": { $in: ['noun', 'verb']} });
        while(await cursor.hasNext()) {
            const wordEntry = await cursor.next();
            const response = await got(`https://www.pealim.com/search/?q=${wordEntry.word}`);
            
            //only nikud and letters. remove dagesh sof pasuk maqaf and paseq etc..
            const wordWithNikud = wordEntry.wordWithSymbols?.match(/[\u05b0-\u05bc\u05c1-\u05c2\u05c7-\u05ea]/g).join('');
            
            //find root
            if (wordWithNikud?.length > 0) {
                mainLogger.info(`Searching for root for word: ${wordWithNikud}`);

                //prepare word without dagesh and word without prefix and wihtout dagesh
                const noDageshAndWordWithNikud = wordWithNikud.replace(/[\u05bc]/g, '');
                const prefix = wordEntry.components?.prefix?.match(/[\u05d0-\u05ea]/g)?.join('');
                let withoutPrefix, withoutPrefixAndDagesh;
                if (prefix) {
                    withoutPrefix = wordWithNikud.replace(wordEntry.components.prefix, '');
                    noDageshAndWithoutPrefix = withoutPrefix.replace(/[\u05bc]/g, '');
                }
                //search for root in verb-search-result
                let element = parse(response.body).querySelectorAll('.verb-search-result').find((verbSearchResult) => {
                    return parse(verbSearchResult).querySelectorAll('.vf-search-result').find((vfSearchResult) => {
                        return parse(vfSearchResult).querySelectorAll('.vf-search-hebrew').find((vfSearchHebrew) => {
                            const menukad = parse(vfSearchHebrew).querySelector('.menukad');
                            if (menukad?.text === wordWithNikud || menukad?.text === noDageshAndWordWithNikud) {
                                return true;
                            }
                            if (prefix) {
                                return vfSearchHebrew?.text.includes(`${prefix}־ + ${withoutPrefix}`) ||
                                       vfSearchHebrew?.text.includes(`${prefix}־ + ${noDageshAndWithoutPrefix}`);
                            }
                            return false;
                        });
                    });
                });

                let rootHebrewLetters;
                if (element) {
                    const rootElement = parse(element).querySelector('.verb-search-root');
                    rootHebrewLetters = rootElement?.text?.match(/[\u05d0-\u05ea]/g);
                }

                //update mongo
                if (rootHebrewLetters?.length > 0) {
                    const root = rootHebrewLetters.join('');
                    const rootEntry = await mongo.getRootsCollection().findOneAndUpdate(
                        { root }, //filter
                        { $setOnInsert: { root }, $addToSet: { wordIds: wordEntry._id } }, //update
                        { upsert: true, returnDocument: 'after' } //options
                    );
                    await mongo.getWordsCollection().findOneAndUpdate({ _id: wordEntry._id }, { $set: { rootId: rootEntry._id }});
                    mainLogger.info(`For word: ${wordWithNikud} Found root: ${root}`);
                } else {
                    await mongo.getWordsCollection().findOneAndUpdate({ _id: wordEntry._id }, { $set: { rootId: null }});
                    mainLogger.info(`Root not found for word: ${wordWithNikud}`);
                }
            }
            await sleep(10000);
        }
    },
    processPartOfSpeech: async () => {
        mainLogger.info('processPartOfSpeech started');
        
        //this is the prompt for the AI
        const system = 'You are a helpful assistant.';
        const messages = [
            'Break down the following sentence into morphological components. ' +
            'The response must be only JSON array of objects named result with no linebreaks. ' +
            'For each word return two fields: components and translation. ' +
            'For each hebrew word components must contain: word, partsOfSpeech, prefix, suffix, tense, person, gender, number and possessive. Otherwise null. ' +
            'partsOfSpeech is an array that contains all parts of speech for a single word. ' +
            'partsOfSpeech can contains 1 or more of the values: noun, pronoun, verb, adjective, adverb, preposition or conjunction. ' +
            'All text must be lowercase. ',
            ''
        ]
        let cursor = await getSentenceCursor(mainLogger);
        while (cursor) {
            let wordEntrys =[];
            while (await cursor.hasNext()) {
                wordEntrys.push(await cursor.next());
            }
            
            //add sentence to messages. remove maqaf, paseq and sof pasuq
            const sentence = wordEntrys.map((wordEntry) => wordEntry.wordWithSymbols.replace(/[\s\u05be\u05c0\u05c3]/g, '')).join(' ');
            messages.pop();
            messages.push(sentence);
            
            //get breakdown to parts of speech from AI
            mainLogger.info(`Calling callAiApi for sentence: ${sentence}`);
            const { result } = await callAiApi(system, messages.join(' '),'partOfSpeechSchema', 0, 4000, mainLogger);
            for (let i = 0;i < result.length;i++) {
                
                //make sure we got the right word. order of symbols can be different
                const returnedWord = result[i].components.word;
                const expectedWord = sentence.split(' ')[i];
                if (!areAllCharsContained(returnedWord, expectedWord) || !areAllCharsContained(expectedWord, returnedWord)) {
                    throw new Error(`Invalid response from AI. Expected ${sentence.split(' ')[i]} but got ${result[i].components.word}`);
                }

                //update mongo
                const { partsOfSpeech, prefix, suffix, tense, person, gender, number, possessive } = result[i].components;
                const components = { partsOfSpeech, prefix, suffix, tense, person, gender, number, possessive };
                await mongo.getWordsCollection().findOneAndUpdate(
                    { _id: wordEntrys[i]._id }, 
                    { $set: { components, translation: result[i].translation } },
                );
                mainLogger.info(`Updated word ${wordEntrys[i].wordWithSymbols} with components ${JSON.stringify(components)} and translation "${result[i].translation}"`);
            }
            cursor = await getSentenceCursor();
        }
    }
}