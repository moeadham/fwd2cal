/* eslint-disable no-unused-vars */
/* eslint-disable max-len */
/* eslint-disable no-undef */
const chai = require("chai");
const chaiHttp = require("chai-http");
const bindings = require("./bindings/binding");
const {exec} = require("child_process");

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5001/fwd2cal/us-central1"; // URL of your Vercel dev server

const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT;
const TESTER_SECONDARY_EMAIL_ACCT = process.env.TESTER_SECONDARY_EMAIL_ACCT;

describe("fwd2cal", () => {
  it("UT00 get login URL and wait for tester to create account", (done) => {
    chai.request(apiURL)
        .get("/signup")
        .redirects(0) // Prevent automatic following of redirects
        .end((err, res) => {
          expect(res).to.have.status(302); // Check that the status is 302
          if (err) {
            console.error("Error fetching signup URL:", err);
            done(err);
          } else {
            console.log("If you want to test - you need to complete this Google Authorization in the next 30 seconds!");
            console.log("-------------------------------------------");
            console.log("Redirect URL:", res.headers.location);
            exec(`open -a "Google Chrome" "${res.headers.location}"`, (error, stdout, stderr) => {
              if (error) {
                console.error("Error opening Google Chrome, maybe this isn't a mac?", error);
              }
              console.log(`stdout: ${stdout}`);
              console.error(`stderr: ${stderr}`);
            });
            setTimeout(() => {
              done();
            }, 20000);
          }
        });
  });
  it("UT01 test generating an event", (done) => {
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
  it("UT02 test adding a new email address", (done) => {
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
  it("UT03 try to  email from secondary email address", (done) => {
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
  it("UT04 approve new email address via request", (done) => {
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
  it("UT05 try to  email from secondary email address", (done) => {
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
  it("UT06 try a basic email with no forward but instructions", (done) => {
    const testMessage = bindings.basicDetailedEmail;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body.data);
      // Should get added to owners calendar.
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.be.an("object");
      expect(res.body.data).to.not.have.property("error");
      expect(res.body.data.kind).to.equal("calendar#event");
      done();
    });
  });
  let inviationLink;
  it("UT07 try a basic email in the future to add invitees later.", (done) => {
    const testMessage = bindings.basicEmailFuture;

    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    const formattedDate = threeDaysFromNow.toLocaleDateString("en-US", {year: "numeric", month: "short", day: "numeric"});
    testMessage.text = testMessage.text.replace("%DATE_IN_THE_FUTURE%", formattedDate);
    testMessage.text = testMessage.text.replace("%DATE_IN_THE_FUTURE%", formattedDate);

    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body.data);
      // Should get added to owners calendar.
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.be.an("object");
      expect(res.body.data).to.not.have.property("error");
      expect(res.body.data.kind).to.equal("calendar#event");
      expect(res.body.data.inviteOthersLink).to.be.an("string");
      inviationLink = res.body.data.inviteOthersLink;
      done();
    });
  });
  it("UT08 invite additional guests via URL", (done) => {
    chai.request(inviationLink).get("").redirects(0).end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(302);
      done();
    });
  });
  it("UT09 add an event with an ics attachment.", (done) => {
    const testMessage = bindings.emailWithICSAttachment;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.attach("attachment", "./test/bindings/calendar.ics", "calendar.ics");
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
  it("UT10 remove secondary email address", (done) => {
    const testMessage = bindings.removeEmailAddress;
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
      expect(res.body.data).to.include("removed");
      done();
    });
  });
  it("UT11 test mailgun callback generates event", (done) => {
    const testMessage = bindings.mailgunEmailFromMain;
    const req = chai.request(apiURL).post("/mailgunCallback").type("form");
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
  it("UT12 delete account", (done) => {
    const testMessage = bindings.deleteAccount;
    const req = chai.request(apiURL).post("/sendgridCallback").type("form");
    Object.keys(testMessage).forEach((key) => {
      req.field(key, testMessage[key]);
    });
    req.end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      console.log(res.body);
      expect(res.body).to.be.an("object");
      expect(res.body.data).to.include("deleted");
      done();
    });
  });
});
