const {transports, createLogger, format} = require('winston');
const fs = require('fs');

const logFile = 'server.log';
const logger = (function () {
    fs.unlink(logFile, (err) => {
        if (err) {
            console.log(`Error deleting file: ${err}`)
        }
    })
    return createLogger({
        level: 'info',
        format: format.combine(
            format.timestamp(),
            format.json()
        ),
        transports: [
            new transports.Console(),
            new transports.File({
                filename: logFile,
              })
        ]
    });
}());

module.exports = logger;
