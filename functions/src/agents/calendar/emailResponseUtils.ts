import {logger} from "firebase-functions/v2";
import {sendEmailResend} from "../../util/resend";
import {getSupportEmail} from "../../util/config";
import {AGENT_EMAIL_ADDRESS} from "./config";
import {getEmailThreadHeaders, threadEmailHtml} from "../../util/emailUtils";
import {mailTemplates} from "./mailTemplates";
import {
  TransformedEmail,
  EmailResponseTemplate,
  EmailResponses,
} from "./types";

export const EMAIL_RESPONSES: EmailResponses = {
  unverifiedEmail: {
    templateName: "unverifiedEmail",
    replace: {
      FROM_EMAIL: "",
    },
  },
  noUserFound: {
    templateName: "noUserFound",
    replace: {
      FROM_EMAIL: "",
    },
  },
  oauthFailed: {
    templateName: "oauthFailed",
    replace: {},
  },
  unableToParse: {
    templateName: "unableToParse",
    replace: {},
  },
  aiParseError: {
    templateName: "aiParseError",
    replace: {
      PARSE_ERROR_DESCRIPTION: "",
    },
  },
  eventAdded: {
    templateName: "eventAdded",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      EVENT_ATTENDEES: "",
      CALENDAR_NAME: "",
    },
  },
  eventAddedAttendees: {
    templateName: "eventAddedAttendees",
    replace: {
      EVENT_LINK: "",
      EVENT_DATE: "",
      INVITE_LINK: "",
      EVENT_ATTENDEES: "",
      CALENDAR_NAME: "",
    },
  },
  addAdditionalEmailAddress: {
    templateName: "addAdditionalEmailAddress",
    replace: {
      VERIFICATION_CODE: "",
      ORIGINATOR_EMAIL: "",
    },
    subject: true,
  },
  additionalEmailInUse: {
    templateName: "additionalEmailInUse",
    replace: {
      EMAIL_TO_ADD: "",
    },
  },
  removalEmailInUse: {
    templateName: "removalEmailInUse",
    replace: {
      EMAIL_TO_REMOVE: "",
    },
  },
  emailAddressRemoved: {
    templateName: "emailAddressRemoved",
    replace: {
      EMAIL_TO_REMOVE: "",
    },
  },
  userDeleted: {
    templateName: "userDeleted",
    replace: {},
  },
};

export function getHtml(messageType: EmailResponseTemplate): string {
  logger.log("messageType", messageType.templateName);
  const template =
    mailTemplates[messageType.templateName as keyof typeof mailTemplates];
  let html = template.html;
  Object.keys(messageType.replace).forEach((key) => {
    html = html.replace(new RegExp(`%${key}%`, "g"), messageType.replace[key]);
  });
  // Replace email placeholders with configured values
  const mainEmail = AGENT_EMAIL_ADDRESS.value();
  const supportEmail = getSupportEmail(mainEmail);
  html = html.replace(/%SUPPORT_EMAIL%/g, supportEmail);
  html = html.replace(/%MAIN_EMAIL%/g, mainEmail);
  return html;
}

export function getSubject(messageType: EmailResponseTemplate): string {
  const template =
    mailTemplates[messageType.templateName as keyof typeof mailTemplates];
  let subject = template.subject || "";
  Object.keys(messageType.replace).forEach((key) => {
    subject = subject.replace(
        new RegExp(`%${key}%`, "g"),
        messageType.replace[key],
    );
  });
  return subject;
}

export async function sendEmailResponse(
    sender: string,
    originalEmail: TransformedEmail,
    messageType: EmailResponseTemplate,
    includeThread: boolean,
): Promise<void> {
  let html = getHtml(messageType);
  let subject = originalEmail.subject || "Re: ";
  if (messageType.subject) {
    subject = getSubject(messageType);
  }
  if (includeThread) {
    html = threadEmailHtml(originalEmail, html);
  }
  await sendEmailResend({
    to: sender,
    from: AGENT_EMAIL_ADDRESS.value(),
    subject: subject,
    html: html,
    headers: getEmailThreadHeaders(originalEmail.headers),
  });
}
