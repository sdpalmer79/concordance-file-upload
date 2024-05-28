const express = require('express');
const router = new express.Router();
const multer = require('multer');
const { getTest, postWordFile, postSymbolsFile, processRoots, processPartsOfSpeech } = require('../handlers/handler')

const upload = multer({ dest: 'uploads/' });

router.route('/test')
    .get(getTest);

router.route('/file/upload')
    .post(upload.single('file'), postWordFile);

router.route('/symbolsFile/upload')
    .post(upload.single('file'), postSymbolsFile);

router.route('/process/roots')
    .post(processRoots);

router.route('/process/parts-of-speech')
    .post(processPartsOfSpeech);

router.all('*', function(req, res) {
    res.status(404);
    res.end();
});

module.exports = router;
