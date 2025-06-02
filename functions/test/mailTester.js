/* eslint-disable no-unused-vars */
/* eslint-disable max-len */
/* eslint-disable no-undef */
const chai = require("chai");
const chaiHttp = require("chai-http");
const fs = require("fs");
const path = require("path");

chai.use(chaiHttp);
const expect = chai.expect;
const apiURL = "http://127.0.0.1:5001/fwd2cal/us-central1"; // Local emulator URL

// Read admin API key from .runtimeconfig.json
let adminApiKey;
try {
  const configPath = path.join(__dirname, "..", ".runtimeconfig.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  adminApiKey = config.environment.admin_api_key;
} catch (error) {
  console.error("Error reading admin_api_key from .runtimeconfig.json:", error.message);
  process.exit(1);
}

describe("Email Tester Endpoint", () => {
  // it("should send test email via SendGrid", (done) => {
  //   chai.request(apiURL)
  //       .post("/testEmail")
  //       .send({
  //         service: "sendgrid",
  //         admin_api_key: adminApiKey,
  //       })
  //       .end((err, res) => {
  //         expect(err).to.be.null;
  //         expect(res).to.have.status(200);
  //         expect(res.body).to.be.an("object");
  //         expect(res.body.success).to.equal(true);
  //         expect(res.body.service).to.equal("sendgrid");
  //         expect(res.body.message).to.include("successfully");
  //         console.log("✅ SendGrid test:", res.body);
  //         done();
  //       });
  // });

  it("should send test email via Mailgun", (done) => {
    chai.request(apiURL)
        .post("/testEmail")
        .send({
          service: "mailgun",
          admin_api_key: adminApiKey,
        })
        .end((err, res) => {
          expect(err).to.be.null;
          expect(res).to.have.status(200);
          expect(res.body).to.be.an("object");
          expect(res.body.success).to.equal(true);
          expect(res.body.service).to.equal("mailgun");
          expect(res.body.message).to.include("successfully");
          console.log("✅ Mailgun test:", res.body);
          done();
        });
  });

  it("should reject request without admin API key", (done) => {
    chai.request(apiURL)
        .post("/testEmail")
        .send({
          service: "sendgrid",
        })
        .end((err, res) => {
          expect(res).to.have.status(401);
          expect(res.body.error).to.equal("Unauthorized");
          console.log("✅ Unauthorized test:", res.body);
          done();
        });
  });

  it("should reject request with invalid service", (done) => {
    chai.request(apiURL)
        .post("/testEmail")
        .send({
          service: "invalid",
          admin_api_key: adminApiKey,
        })
        .end((err, res) => {
          expect(res).to.have.status(400);
          expect(res.body.error).to.include("service must be");
          console.log("✅ Invalid service test:", res.body);
          done();
        });
  });

  it("should reject GET requests", (done) => {
    chai.request(apiURL)
        .get("/testEmail")
        .end((err, res) => {
          expect(res).to.have.status(405);
          expect(res.body.error).to.equal("Method not allowed");
          console.log("✅ Method not allowed test:", res.body);
          done();
        });
  });
});
