import {OpenAIInstrumentation} from
  "@arizeai/openinference-instrumentation-openai";
import {getApp, initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {onInit} from "firebase-functions/v2/core";
import {NodeSDK} from "@opentelemetry/sdk-node";

const openAIInstrumentation = new OpenAIInstrumentation({
  traceConfig: {
    hideInputs: true,
    hideOutputs: true,
  },
});

const importEsm = new Function(
    "specifier",
    "return import(specifier)",
) as (specifier: string) => Promise<typeof import("@agentpond/firebase")>;

// Register the module hook before routes load the OpenAI SDK. The exporter is
// ESM-only, so Firebase's async initialization hook loads it before requests.
openAIInstrumentation.enable();

onInit(async () => {
  try {
    getApp();
  } catch {
    initializeApp();
  }

  const db = getFirestore();
  db.settings({ignoreUndefinedProperties: true});

  const {createFirebaseSpanExporter} = await importEsm("@agentpond/firebase");
  const sdk = new NodeSDK({
    serviceName: "fwd2cal",
    traceExporter: createFirebaseSpanExporter(),
    instrumentations: [openAIInstrumentation],
  });

  sdk.start();
});
