import {logger} from "firebase-functions/v2";
import moment from "moment-timezone";
import {sendEvent} from "./analytics";
import {TransformedEmail, EmailThreadHeaders} from "./types";

/**
 * Validates an email address format
 * Supports + character and other common email patterns
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * Extracts the sender email from a transformed email object
 */
function getSenderFromRawEmail(email: TransformedEmail): string | undefined {
  return email.from ? email.from.toLowerCase() : undefined;
}

/**
 * Extracts recipient emails from a transformed email object
 */
function getRecipientsFromRawEmail(email: TransformedEmail): string[] {
  const to = email.to || [];
  return to.map((emailAddr) => emailAddr.toLowerCase());
}

/**
 * Extracts specified headers from an email headers object (case-insensitive)
 */
function getEmailHeaders(
    headers: Record<string, string>,
    items: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!headers || typeof headers !== "object") {
      return result;
    }

    items.forEach((item) => {
      const key = Object.keys(headers).find(
          (k) => k.toLowerCase() === item.toLowerCase(),
      );
      if (key && headers[key]) {
        result[item] =
          typeof headers[key] === "string" ? headers[key].trim() : headers[key];
      }
    });
  } catch (error) {
    logger.warn("Error extracting headers", error);
  }
  return result;
}

/**
 * Builds email threading headers (In-Reply-To, References) for reply emails
 */
function getEmailThreadHeaders(
    headers: Record<string, string>,
): EmailThreadHeaders {
  const extracted = getEmailHeaders(headers, ["Message-ID", "References"]);

  const messageId = extracted["Message-ID"];
  const existingReferences = extracted["References"];

  const threadHeaders: EmailThreadHeaders = {};

  if (messageId) {
    threadHeaders["In-Reply-To"] = messageId;

    if (existingReferences) {
      threadHeaders["References"] = `${existingReferences} ${messageId}`;
    } else {
      threadHeaders["References"] = messageId;
    }
  }

  return threadHeaders;
}

/**
 * Strip base64-encoded images from HTML
 * Resend doesn't allow sending emails with inline base64 images
 */
function stripBase64Images(html: string): string {
  if (!html) return html;

  return html.replace(
      /<img[^>]*\ssrc\s*=\s*["']data:image\/[^"']*["'][^>]*>/gi,
      "[Image removed]",
  );
}

/**
 * Creates Gmail-style threaded email HTML with quoted original message
 */
function threadEmailHtml(original: TransformedEmail, html: string): string {
  if (!html) html = "";
  try {
    let senderDisplay = original.from;
    if (original.headers && original.headers.from) {
      const fromHeader = original.headers.from.replace(/^"(.*)"$/, "$1");
      const match = fromHeader.match(/^(.+?)\s*<(.+?)>$/);
      if (match) {
        senderDisplay = `${match[1].replace(/^"|"$/g, "")} <${match[2]}>`;
      } else {
        senderDisplay = fromHeader;
      }
    }

    let formattedDate = "";
    let formattedTime = "";
    if (original.headers && original.headers.date) {
      const dateString = original.headers.date.replace(/^"(.*)"$/, "$1");
      const dateMoment = moment(dateString, moment.RFC_2822, true).isValid() ?
        moment(dateString, moment.RFC_2822, true) :
        moment(dateString);
      if (dateMoment.isValid()) {
        formattedDate = dateMoment.utc().format("ddd, MMM D, YYYY");
        formattedTime = dateMoment.utc().format("h:mm A") + " UTC";
      }
    }

    const cleanedHtml = stripBase64Images(original.html);

    if (formattedDate && formattedTime) {
      const threadLine = `On ${formattedDate}, at ${formattedTime}, ${senderDisplay} wrote:`;
      return `${html}<br>
<div class="gmail_quote">
<div dir="ltr" class="gmail_attr">
${threadLine}<br>
</div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left-width:1px;\
border-left-style:solid;padding-left:1ex;border-left-color:rgb(204,204,204)">
${cleanedHtml}
</blockquote>
</div>`;
    }
  } catch (error) {
    logger.warn("Error threading email HTML", error);
  }

  return `${html}${stripBase64Images(original.html)}`;
}

/**
 * Verifies email authenticity via SPF and DKIM checks
 */
function verifyEmail(email: TransformedEmail): boolean {
  logger.info("Email verification check", {
    from: email.from,
    SPF: email.SPF,
    dkim: email.dkim,
  });

  if (email.SPF !== "pass") {
    logger.warn("Email verification failed: SPF check failed", {
      from: email.from,
      SPF: email.SPF,
      expected: "pass",
    });
    sendEvent(email.from, "emailRejected", {reason: "spf_failed"});
    return false;
  }

  if (email.dkim.indexOf("pass") === -1) {
    logger.warn("Email verification failed: DKIM check failed", {
      from: email.from,
      dkim: email.dkim,
      containsPass: email.dkim.indexOf("pass") !== -1,
    });
    sendEvent(email.from, "emailRejected", {reason: "dkim_failed"});
    return false;
  }

  logger.info("Email verification passed", {
    from: email.from,
  });

  return true;
}

export {
  isValidEmail,
  getSenderFromRawEmail,
  getRecipientsFromRawEmail,
  getEmailHeaders,
  getEmailThreadHeaders,
  stripBase64Images,
  threadEmailHtml,
  verifyEmail,
};
