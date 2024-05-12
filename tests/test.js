const chai = require('chai');
const chaiHttp = require('chai-http');
const server = require('../server'); // replace with path to your server file
const expect = chai.expect;

chai.use(chaiHttp);

/* TODO: iMPLMENT TESTS */

describe('POST /file/upload', function() {
  it('should upload a file', function(done) {
    chai.request(server)
      .post('/file/upload')
      .attach('file', fs.readFileSync('path/to/test/file'), 'testfile.txt')
      .end(function(err, res) {
        expect(err).to.be.null;
        expect(res).to.have.status(200);
        // Add more assertions as needed
        done();
      });
  });
});