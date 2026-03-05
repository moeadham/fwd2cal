import {logger} from "firebase-functions/v2";
import {getUserFromEmail, getUserFromUID, USERS_COLLECTION} from "../../util/firestoreHandler";
import {selectSkill} from "./llm";
import {getSkills, getSkillsContext} from "./skills";
import {fastMatchSkill} from "../../util/skills/matcher";
import {sendEmailResend} from "../../util/resend";
import {
  ENVIRONMENT_NAME,
  SKILL_CONFIDENCE_THRESHOLD,
  SKILL_BODY_EXCERPT_LENGTH,
  getSupportEmail,
  getAdminEmail,
} from "../../util/config";
import {AGENT_EMAIL_ADDRESS} from "./config";
import {
  getSenderFromRawEmail,
  getRecipientsFromRawEmail,
  verifyEmail,
} from "../../util/emailUtils";
import {sendEvent} from "../../util/analytics";
import {
  fetchAndTransformEmail,
  EmailFetchError,
} from "../../resend/emailFetcher";
import {processAttachments} from "./attachmentHandler";
import {getLastSentEmail} from "../../util/resendMock";
import {TaskRequest, DispatchResult} from "../../util/types";
import {
  TransformedEmail,
  ICSFile,
  EmailResponseTemplate,
  HandleEmailResult,
  GoogleCalendarEvent,
  ParsedDocument,
} from "./types";
import {sendEmailResponse, EMAIL_RESPONSES} from "./emailResponseUtils";
import {
  deleteUserAccount,
  removeEmailAddressFromUser,
  addEmailAddressToUser,
} from "./accountHandler";
import {eventHandler} from "./eventHandler";

async function handleEmail(
    email: TransformedEmail,
    files: ICSFile[],
    imageUrls: string[] = [],
    documents: ParsedDocument[] = [],
): Promise<HandleEmailResult | GoogleCalendarEvent | GoogleCalendarEvent[] | undefined> {
  // Do we know this user?
  const sender = getSenderFromRawEmail(email);
  if (!sender) {
    return {error: "No sender found"};
  }

  // Is the email sender verified?
  if (!verifyEmail(email)) {
    logger.warn("Unverified Email");
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.unverifiedEmail,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    return {error: "Unverified email address"};
  }

  // Is this a support email?
  const to = getRecipientsFromRawEmail(email);
  if (
    to.includes(getSupportEmail(AGENT_EMAIL_ADDRESS.value())) ||
    to.includes(getAdminEmail(AGENT_EMAIL_ADDRESS.value())) ||
    (email.subject &&
      email.subject.toLowerCase().startsWith("verify your email address"))
  ) {
    // To handle google account creation.
    return await sendToSupport(sender, email);
  }

  const uid = await getUserFromEmail(sender);
  let isCalendarUser = false;
  if (uid) {
    try {
      await getUserFromUID(uid, USERS_COLLECTION);
      isCalendarUser = true;
    } catch {
      // User exists in EmailAddress (e.g. drive-only) but not in Users
    }
  }
  if (!uid || !isCalendarUser) {
    logger.warn(`No User found with ${sender}`);
    const response: EmailResponseTemplate = {
      ...EMAIL_RESPONSES.noUserFound,
      replace: {
        FROM_EMAIL: sender,
      },
    };
    await sendEmailResponse(sender, email, response, true);
    sendEvent(sender, "userInvited");
    return {result: `${sender} has been invited to signup`};
  }

  const skillResult = await detectSkill(email.subject, email.text, uid);
  logger.log(`Request from ${sender} to ${skillResult.skillId}`);
  // Track all received emails with the skill type
  sendEvent(uid, "emailReceived", {action: skillResult.skillId});

  switch (skillResult.skillId) {
    case "add-email":
      return await addEmailAddressToUser(email, sender, uid, files, imageUrls, documents, skillResult.extractedValue);
    case "remove-email":
      return await removeEmailAddressFromUser(
          email, sender, uid, files, imageUrls, documents, skillResult.extractedValue);
    case "delete-account":
      return await deleteUserAccount(email, sender, uid);
    case "add-event":
      return await eventHandler(email, sender, uid, files, imageUrls, documents);
    default:
      return await eventHandler(email, sender, uid, files, imageUrls, documents);
  }
}

async function sendToSupport(
    sender: string,
    email: TransformedEmail,
): Promise<HandleEmailResult> {
  logger.log(`Support email received from ${sender}`);
  logger.log(email.subject);
  logger.log(email.text);
  const content = `From: ${sender} <br><br> Subject: ${email.subject} <br><br> ${email.html}`;
  await sendEmailResend({
    to: "fwd2cal@googlegroups.com",
    from: AGENT_EMAIL_ADDRESS.value(),
    subject: email.subject,
    html: content,
  });
  return {result: `email forwarded to support group.`};
}

interface SkillResult {
  skillId: string;
  extractedValue?: string;
}

/**
 * Detect the appropriate skill based on email subject and body.
 * Uses hybrid approach: fast regex matching first, LLM fallback for ambiguous cases.
 */
async function detectSkill(
    subject: string,
    body: string,
    uid: string | null = null,
): Promise<SkillResult> {
  const normalizedSubject = (subject || "").trim();
  const normalizedBody = (body || "").trim();

  const skills = getSkills();

  // Fast path - regex matching on subject and body
  const fastMatch = fastMatchSkill(normalizedSubject, normalizedBody, skills);
  if (fastMatch) {
    logger.log(`Fast match in ${fastMatch.matchedIn}: "${fastMatch.skillId}"`);
    return {
      skillId: fastMatch.skillId,
      extractedValue: fastMatch.extractedValue,
    };
  }

  // LLM fallback for ambiguous cases
  try {
    const excerptLength = parseInt(SKILL_BODY_EXCERPT_LENGTH.value());
    const bodyExcerpt = normalizedBody.substring(0, excerptLength);
    const skillsContext = getSkillsContext();
    const selection = await selectSkill(
        normalizedSubject,
        bodyExcerpt,
        skillsContext,
        uid,
    );
    logger.log(
        `LLM skill selection: ${selection.skill_id} ` +
        `(confidence: ${selection.confidence}, reason: ${selection.reasoning})`,
    );

    const threshold = parseFloat(SKILL_CONFIDENCE_THRESHOLD.value());
    if (selection.confidence > threshold) {
      return {
        skillId: selection.skill_id,
        extractedValue: selection.extracted_value || undefined,
      };
    }
  } catch (error) {
    logger.error("Skill selection error, defaulting to add-event:", error);
  }

  // Default skill
  return {skillId: "add-event"};
}

async function handleResendInboundDispatch(
    req: TaskRequest,
): Promise<DispatchResult> {
  const webhookData = req.data;

  let transformedEmail;
  let emailData;
  let resend;
  try {
    const result = await fetchAndTransformEmail(webhookData);
    transformedEmail = result.transformedEmail;
    emailData = result.emailData;
    resend = result.resend;
  } catch (error) {
    if (error instanceof EmailFetchError) {
      return {message: "error", error: error.message};
    }
    throw error;
  }

  // Log FULL emailData JSON response
  logger.info("Full emailData JSON response", emailData);

  // Log SPF/DKIM extraction results
  logger.info("SPF/DKIM extraction results", {
    authResultsRaw: emailData.headers?.["authentication-results"] || "EMPTY",
    spfResult: transformedEmail.SPF,
    dkimResultRaw: transformedEmail.dkim,
  });

  // Log transformed email object
  logger.info("Transformed email object", {
    from: transformedEmail.from,
    to: transformedEmail.to,
    subject: transformedEmail.subject,
    SPF: transformedEmail.SPF,
    dkim: transformedEmail.dkim,
    textLength: transformedEmail.text?.length || 0,
    htmlLength: transformedEmail.html?.length || 0,
    headerCount: Object.keys(transformedEmail.headers).length,
  });

  // Handle attachments (ICS files, images, and documents)
  // eslint-disable-next-line camelcase
  const {email_id} = webhookData.data;
  const {icsFiles, imageUrls, documents} = await processAttachments(resend, email_id);

  if (ENVIRONMENT_NAME.value() !== "production") {
    logger.log("RESEND WEBHOOK DATA", webhookData);
    logger.log("FETCHED EMAIL DATA", emailData);
    logger.log("TRANSFORMED EMAIL", transformedEmail);
    logger.log("ICS FILES", icsFiles);
    logger.log("IMAGE URLS", imageUrls);
    logger.log("DOCUMENTS", documents.map((d) => d.filename));
  }

  // Process the email
  const outcome = await handleEmail(transformedEmail, icsFiles, imageUrls, documents);

  // Get the sent email data from mock for testing (non-production only)
  let sentEmail = null;
  if (ENVIRONMENT_NAME.value() !== "production") {
    sentEmail = getLastSentEmail(transformedEmail.from);
  }

  return {
    message: "thanks",
    data: outcome,
    sentEmail: sentEmail,
  };
}

export {handleEmail, handleResendInboundDispatch};
