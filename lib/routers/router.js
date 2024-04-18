const express = require('express');
const router = new express.Router();
const multer = require('multer');
const { getTest, postFile } = require('../handlers/handler')

const upload = multer({ dest: 'uploads/' });

router.route('/test')
    .get(getTest);

router.route('/file/upload')
    .post(upload.single('file'), postFile);

router.all('*', function(req, res) {
    res.status(404);
    res.end();
});

module.exports = router;
