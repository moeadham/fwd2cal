/* eslint-disable max-len */
/* eslint-disable no-undef */
const chai = require("chai");
const chaiHttp = require("chai-http");
const bindings = require("./binding");


chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5001/fwd2cal/us-central1"; // URL of your Vercel dev server

describe("fwd2cal", () => {
  it("UT1 test generating an event", (done) => {
    const testMessage = bindings.email1;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      expect(res.body).to.be.an("object");
      expect(res.body.data.kind).to.equal("calendar#event");
      done();
    });
  });
  it("UT2 test adding a new email address", (done) => {
    const testMessage = bindings.addEmailAddress;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      expect(res.body).to.be.an("object");
      done();
    });
  });
});
