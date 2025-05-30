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

  const maxRetries = 1;
  const retryDelay = 1000; // 1 second

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(url, eventData, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.192 Safari/537.36",
        },
        timeout: 5000, // 5 second timeout
      });
      logger.debug("GA event sent successfully:", response.data);
      return; // Success, exit function
    } catch (error) {
      const isRetriableError = error.code === "ECONNRESET" || 
                              error.code === "ETIMEDOUT" ||
                              error.message.includes("socket hang up") ||
                              error.message.includes("timeout") ||
                              (error.response && error.response.status >= 500);

      if (attempt < maxRetries && isRetriableError) {
        logger.warn(`GA Error sending event (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        logger.error("GA Error sending event:", error.response ? error.response.data : error.message);
        return; // Give up after max retries or non-retriable error
      }
    }
  }
}

module.exports = {sendEvent};

