/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const axios = require("axios");
const {GA_MEASUREMENT, GA_SECRET, ENVIRONMENT} = require("./credentials");
const {logger} = require("firebase-functions");

async function sendEvent(uid, eventName, eventParams = {}) {
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT}&api_secret=${GA_SECRET}`;
  if (ENVIRONMENT !== "production") {
    eventParams.traffic_type = "internal";// Marking the event as debug mode
  }
  const eventData = {
    client_id: uid, // This should be a unique identifier for each user or session.
    events: [{
      name: eventName, // Replace with your event name
      params: eventParams,
    }],
  };
  try {
    const response = await axios.post(url, eventData, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.192 Safari/537.36",
      },
    });
    logger.debug("GA event sent successfully:", response.data);
  } catch (error) {
    logger.error("GA Error sending event:", error.response ? error.response.data : error.message);
  }
}

module.exports = {sendEvent};

