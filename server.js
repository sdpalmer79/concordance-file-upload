const logger = require('./lib/common/logging');
const express = require('express');
const expressWinston = require('express-winston');
const mongo = require('./lib/storage/mongo');
const { v4 } = require('uuid');
const app = express();
const router = require('./lib/routers/router');

const PORT = process.env.PORT || '929';

let server;

const requestStartHandler = function (req, res, next) {
    const flowContextId = req.headers.flow_context || v4();
    res.set({ flowContextId });
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    req.logger = logger.child({ flowContextId, url: decodeURIComponent(req.url), port: req.socket.localPort, clientIp });
    req.flowContextId = flowContextId;
    next();
};

app.use(expressWinston.logger({
    winstonInstance: logger
}));
app.use(requestStartHandler);
app.use(express.static('public'));
app.use('/', router);
server = app.listen(PORT);

server.on('listening', async () => {
    logger.warn(`Server listening on port ${PORT}`);
    await mongo.init();
});

server.on('error', (err) => {
    logger.error('Server error ', err);
});

process.on("SIGINT", async (code) => {
    server.close();
    await mongo.close();
    logger.warn(`terminating with code ${code}`);
});
process.on("SIGTERM", async (code) => {
    server.close();
    await mongo.close();
    logger.warn(`terminating with code ${code}`);
});

process.on('multipleResolves', (type, promise, reason) => {
    logger.warn(`multipleResolves ${type} ${promise} ${reason}`);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at: ' + promise + ' reason: ' + reason.stack);
});

/* TO DO
create 'manage' endpoints
health checks
otel?
check for required env variables
move express logger to common/logging
 */
