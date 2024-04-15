const express = require('express');
const router = new express.Router();
const { getTest } = require('../handlers/handler')

router.route('/test')
    .get(getTest);

module.exports = router;
