import { PostHog } from "posthog-node";
import { POSTHOG_API_KEY, ENVIRONMENT_NAME } from "./config";
import { logger } from "firebase-functions/v2";
import { AnalyticsEventParams } from "../types";

// Initialize PostHog client with serverless-optimized settings
// flushAt: 1 and flushInterval: 0 ensure immediate flushing for Firebase Functions
let posthogClient: PostHog | null = null;

function getPostHogClient(): PostHog {
  if (!posthogClient) {
    posthogClient = new PostHog(POSTHOG_API_KEY.value(), {
      host: "https://eu.i.posthog.com",
      flushAt: 1, // Flush after each event (required for serverless)
      flushInterval: 0, // Don't use time-based flushing (required for serverless)
    });
  }
  return posthogClient;
}

async function sendEvent(
  uid: string,
  eventName: string,
  eventParams: AnalyticsEventParams = {}
): Promise<void> {
  try {
    const client = getPostHogClient();

    // Mark non-production traffic (same as GA implementation)
    if (ENVIRONMENT_NAME.value() !== "production") {
      eventParams.traffic_type = "internal";
    }

    // Send event to PostHog
    client.capture({
      distinctId: uid, // User identifier (maps from GA's client_id)
      event: eventName, // Event name
      properties: eventParams, // Event properties (maps from GA's params)
    });

    // Ensure events are flushed before function completes
    await client.shutdown();

    // Reset client for next invocation
    posthogClient = null;

    logger.debug("PostHog event sent successfully:", eventName);
  } catch (error) {
    // Log error but don't throw - analytics failures shouldn't break core functionality
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("PostHog Error sending event:", errorMessage);
  }
}

export { sendEvent };
