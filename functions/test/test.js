/* eslint-disable no-unused-vars */
/* eslint-disable max-len */
/* eslint-disable no-undef */
const chai = require("chai");
const chaiHttp = require("chai-http");
const bindings = require("./binding");


chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5001/fwd2cal/us-central1"; // URL of your Vercel dev server

const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT;
const TESTER_SECONDARY_EMAIL_ACCT = process.env.TESTER_SECONDARY_EMAIL_ACCT;

describe("fwd2cal", () => {
  it("UT1 test generating an event", (done) => {
    const testMessage = bindings.emailFromMain;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      expect(res.body).to.be.an("object");
      // We should get an event
      expect(res.body.data).to.not.have.property("error");
      expect(res.body.data.kind).to.equal("calendar#event");
      done();
    });
  });
  let verificationCode = "";
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
      // Should get a verification code.
      expect(res.body).to.be.an("object");
      expect(res.body.data.verificationCode).to.be.an("String");
      verificationCode = res.body.data.verificationCode;
      done();
    });
  });
  it("UT3 try to  email from secondary email address", (done) => {
    const testMessage = bindings.eventEmailFromSecondEmail;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      expect(res.body).to.be.an("object");
      expect(res.body.data.result).to.be.an("string");
      expect(res.body.data.result).to.contain("has been invited to signup");
      done();
    });
  });
  it("UT4 approve new email address via request", (done) => {
    const req = chai.request(apiURL).post("/verifyAdditionalEmail").query({uuid: verificationCode});
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      // should get a webpage thanking us.
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.equal(TESTER_PRIMARY_GOOGLE_ACCT);
      done();
    });
  });
  it("UT5 try to  email from secondary email address", (done) => {
    const testMessage = bindings.eventEmailFromSecondEmail;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      // Should get added to owners calendar.
      expect(res.body).to.be.an("object");
      done();
    });
  });
  it("UT6 try a basic email with no forward but instructions", (done) => {
    const testMessage = bindings.basicDetailedEmail;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      // Should get added to owners calendar.
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.be.an("object");
      expect(res.body.data).to.not.have.property("error");
      expect(res.body.data.kind).to.equal("calendar#event");
      done();
    });
  });
});
