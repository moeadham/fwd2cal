/* eslint-disable no-irregular-whitespace */
/* eslint-disable no-tabs */
/* eslint-disable max-len */

const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT || "";
const TESTER_SECONDARY_EMAIL_ACCT = process.env.TESTER_SECONDARY_EMAIL_ACCT || "";
const MAIN_EMAIL_ADDRESS = process.env.MAIN_EMAIL_ADDRESS || "calendar@fwd2cal.com";
const DRIVE_EMAIL_ADDRESS = process.env.DRIVE_EMAIL_ADDRESS || "drive@fwd2cal.com";

interface WebhookData {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    message_id: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    created_at: string;
    attachments: AttachmentData[];
  };
}

interface AttachmentData {
  id: string;
  filename: string;
  content_type: string;
  content_id?: string;
  content_disposition?: string;
  size: number;
}

interface EmailHeaders {
  "authentication-results": string;
  from: string;
  to: string;
  subject: string;
  date: string;
  "message-id": string;
  "in-reply-to": string;
  references: string;
}

interface EmailContent {
  id: string;
  subject: string;
  from: string;
  to: string[];
  html: string;
  text: string;
  headers: EmailHeaders;
  attachments?: AttachmentData[];
}

interface AttachmentWithUrl extends AttachmentData {
  download_url: string;
  expires_at: string;
}

interface ResendTestData {
  webhook: WebhookData;
  emailContent: EmailContent;
  attachmentsList?: AttachmentWithUrl[];
}

// Helper function to create Resend test data structure
function createResendTestData(webhookData: WebhookData, emailContent: EmailContent): ResendTestData {
  return {
    webhook: webhookData,
    emailContent: emailContent,
  };
}

// Helper function to generate authentication-results header
function generateAuthHeader(from: string): string {
  const domain = from.split("@")[1];
  return `amazonses.com; spf=pass (spfCheck: domain of _spf.${domain} designates 209.85.214.171 as permitted sender) client-ip=209.85.214.171; envelope-from=${from}; helo=mail.${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`;
}

// Test 1: Basic forwarded email
const emailFromMain: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-1",
      message_id: `<test-1-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Finess Clinic Appointment Confirmation",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-1",
    subject: "Fwd: Finess Clinic Appointment Confirmation",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Finess Clinic</strong> <span dir="auto">&lt;<a href="mailto:noreply@treatwell.co.uk">noreply@treatwell.co.uk</a>&gt;</span><br>Date: Tue, Mar 26, 2024 at 11:04 AM<br>Subject: Finess Clinic Appointment Confirmation<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p><strong>Your booking is confirmed</strong></p><p>Order reference: W1503268392</p><p><strong>Your appointment</strong></p><p>Wednesday, 26 March 2025, 11:15 AM</p><p>Acupuncture<br>30 minutes session</p><p>Amount to pay at the salon<br>£45.00</p><p>Finess Clinic<br>Suite 1, Beatty House, Admirals Way, Canary Wharf, London, UK, E14 9UF</p></div></div>`,
    text: `---------- Forwarded message ---------
From: Finess Clinic <noreply@treatwell.co.uk>
Date: Tue, Mar 26, 2024 at 11:04 AM
Subject: Finess Clinic Appointment Confirmation
To: ${TESTER_PRIMARY_GOOGLE_ACCT}


Your booking is confirmed

Order reference: W1503268392

Your appointment

Wednesday, 26 March 2025, 11:15 AM

Acupuncture
30 minutes session

Amount to pay at the salon
£45.00

Finess Clinic
Suite 1, Beatty House, Admirals Way, Canary Wharf, London, UK, E14 9UF`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Finess Clinic Appointment Confirmation",
      "date": "Tue, 26 Mar 2024 12:38:21 +0000",
      "message-id": `<test-1-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-1>",
      "references": "<original-message-1>",
    },
  },
);

// Test 2: Add email address
const addEmailAddress: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-2",
      message_id: `<test-2-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-2",
    subject: `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr">add ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
    text: `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
      "date": "Thu, 28 Mar 2025 10:38:21 +0000",
      "message-id": `<test-2-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-2>",
      "references": "<original-message-2>",
    },
  },
);

// Test 2b: Add email address (in body only, no subject)
const TESTER_BODYTEST_EMAIL = TESTER_PRIMARY_GOOGLE_ACCT.replace("@", "+bodytest@");
const addEmailAddressInBody: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-2b",
      message_id: `<test-2b-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Request",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-2b",
    subject: "Request",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr">Please add ${TESTER_BODYTEST_EMAIL} to my account.</div>`,
    text: `Please add ${TESTER_BODYTEST_EMAIL} to my account.`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Request",
      "date": "Thu, 28 Mar 2025 10:45:00 +0000",
      "message-id": `<test-2b-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-2b>",
      "references": "<original-message-2b>",
    },
  },
);

// Test 3: Remove email address
const removeEmailAddress: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-3",
      message_id: `<test-3-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-3",
    subject: `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr">remove ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
    text: `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
      "date": "Fri, 30 May 2025 11:00:00 +0000",
      "message-id": `<test-3-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-3>",
      "references": "<original-message-3>",
    },
  },
);

// Test 4: Delete account
const deleteAccount: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-4",
      message_id: `<test-4-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "delete account",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-4",
    subject: "delete account",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: "",
    text: "",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "delete account",
      "date": "Fri, 30 May 2025 12:00:00 +0000",
      "message-id": `<test-4-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-4>",
      "references": "<original-message-4>",
    },
  },
);

// Test 5: Event from secondary email
const eventEmailFromSecondEmail: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-5",
      message_id: `<test-5-${Date.now()}@mail.gmail.com>`,
      from: TESTER_SECONDARY_EMAIL_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Tottenham Hotspur v Arsenal Premier League Match",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-5",
    subject: "Fwd: Tottenham Hotspur v Arsenal Premier League Match",
    from: TESTER_SECONDARY_EMAIL_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Tottenham Hotspur</strong> <span dir="auto">&lt;<a href="mailto:noreply@tottenhamhotspur.com">noreply@tottenhamhotspur.com</a>&gt;</span><br>Date: Wed, Apr 24, 2025 at 2:30 PM<br>Subject: Tottenham Hotspur v Arsenal Premier League Match<br>To: &lt;<a href="mailto:${TESTER_SECONDARY_EMAIL_ACCT}">${TESTER_SECONDARY_EMAIL_ACCT}</a>&gt;<br></div><br><p><strong>TOTTENHAM HOTSPUR V ARSENAL</strong></p><p>Premier League</p><p>Sunday 28 April 2025</p><p>Kick-off: 2pm</p><p>Your tickets will remain valid for this fixture.</p><p>Tottenham Hotspur Stadium</p></div></div>`,
    text: `---------- Forwarded message ---------
From: Tottenham Hotspur <noreply@tottenhamhotspur.com>
Date: Wed, Apr 24, 2025 at 2:30 PM
Subject: Tottenham Hotspur v Arsenal Premier League Match
To: <${TESTER_SECONDARY_EMAIL_ACCT}>

TOTTENHAM HOTSPUR V ARSENAL

Premier League

Sunday 28 April 2025

Kick-off: 2pm

Your tickets will remain valid for this fixture.

Tottenham Hotspur Stadium`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_SECONDARY_EMAIL_ACCT),
      "from": `Jon Doe <${TESTER_SECONDARY_EMAIL_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Tottenham Hotspur v Arsenal Premier League Match",
      "date": "Thu, 25 Apr 2025 14:30:00 +0000",
      "message-id": `<test-5-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-5>",
      "references": "<original-message-5>",
    },
  },
);

// Test 6: Basic detailed email with forward
const basicDetailedEmail: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-6",
      message_id: `<test-6-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Meet Jimmy for coffee",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-6",
    subject: "Fwd: Meet Jimmy for coffee",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Jimmy</strong> <span dir="auto">&lt;<a href="mailto:jimmy@example.com">jimmy@example.com</a>&gt;</span><br>Date: Thu, Apr 4, 2025 at 10:00 AM<br>Subject: Meet Jimmy for coffee<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p>Hey!</p><p>Let's meet for coffee at Starbucks on Friday April 4th at 1pm.</p><p>Thanks,<br>Jimmy</p></div></div>`,
    text: `---------- Forwarded message ---------
From: Jimmy <jimmy@example.com>
Date: Thu, Apr 4, 2025 at 10:00 AM
Subject: Meet Jimmy for coffee
To: <${TESTER_PRIMARY_GOOGLE_ACCT}>

Hey!

Let's meet for coffee at Starbucks on Friday April 4th at 1pm.

Thanks,
Jimmy`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Meet Jimmy for coffee",
      "date": "Thu, 4 Apr 2025 10:00:00 +0000",
      "message-id": `<test-6-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-6>",
      "references": "<original-message-6>",
    },
  },
);

// Test 7: Future event with date placeholder
const basicEmailFuture: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-7",
      message_id: `<test-7-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Meet Jimmy for Coffee",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-7",
    subject: "Meet Jimmy for Coffee",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><p>Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%</p><p>Gill.</p></div>`,
    text: `  ---------- Forwarded message ---------
  From: Gill Bates <${TESTER_SECONDARY_EMAIL_ACCT}>
  Date: Tue, Mar 21, 2025 at 11:04 AM
  Subject: meet jimmy for coffee
  To: <${TESTER_PRIMARY_GOOGLE_ACCT}>

  Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%

  Gill.`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Meet Jimmy for Coffee",
      "date": "Fri, 30 May 2025 10:00:00 +0000",
      "message-id": `<test-7-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-7>",
      "references": "<original-message-7>",
    },
  },
);

// Test 8: Email with ICS attachment
const emailWithICSAttachment: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-8",
      message_id: `<test-8-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "email with ics attachment",
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: "attachment-1",
          filename: "calendar.ics",
          content_type: "text/calendar",
          content_id: "<attachment1>",
          content_disposition: "attachment",
          size: 500,
        },
      ],
    },
  },
  {
    id: "test-email-8",
    subject: "email with ics attachment",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: "<p>here is the ics</p>",
    text: "here is the ics",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "email with ics attachment",
      "date": "Thu, 28 Mar 2025 10:38:21 +0000",
      "message-id": `<test-8-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-8>",
      "references": "<original-message-8>",
    },
    attachments: [
      {
        id: "attachment-1",
        filename: "calendar.ics",
        content_type: "text/calendar",
        content_id: "<attachment1>",
        content_disposition: "attachment",
        size: 500,
      },
    ],
  },
);

// Add attachmentsList with download URL for ICS test
// Token stored in env var to avoid GitHub secret scanning flags
const ICS_TEST_FILE_TOKEN = process.env.ICS_TEST_FILE_TOKEN || "";
const ICS_BASE_URL = "https://firebasestorage.googleapis.com/v0/b/fwd2cal.firebasestorage.app/o/test%2Fcalendar.ics?alt=media";
emailWithICSAttachment.attachmentsList = [
  {
    id: "attachment-1",
    filename: "calendar.ics",
    content_type: "text/calendar",
    content_id: "<attachment1>",
    content_disposition: "attachment",
    size: 500,
    download_url: ICS_TEST_FILE_TOKEN ? `${ICS_BASE_URL}&token=${ICS_TEST_FILE_TOKEN}` : ICS_BASE_URL,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
];

// Test: Email with PDF attachment containing event details
// The email body intentionally has NO event details - event info is only in the PDF
const emailWithPDFAttachment: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-pdf",
      message_id: `<test-pdf-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Conference Registration",
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: "pdf-attachment-1",
          filename: "conference_registration.pdf",
          content_type: "application/pdf",
          content_id: "<pdfattachment1>",
          content_disposition: "attachment",
          size: 15000,
        },
      ],
    },
  },
  {
    id: "test-email-pdf",
    subject: "Fwd: Conference Registration",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><p>Please see attached for the conference details.</p></div>`,
    text: `Please see attached for the conference details.`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Conference Registration",
      "date": "Mon, 1 Jul 2025 09:00:00 +0000",
      "message-id": `<test-pdf-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-pdf>",
      "references": "<original-message-pdf>",
    },
  },
);

// PDF test file with event details (Tech Conference 2026, July 15, 2026, 9:00 AM - 5:00 PM, San Francisco Convention Center)
// File located at: test/bindings/conference_registration.pdf
const PDF_FILE_PATH = require("path").join(__dirname, "conference_registration.pdf");

// Add attachmentsList with file URL for PDF test
emailWithPDFAttachment.attachmentsList = [
  {
    id: "pdf-attachment-1",
    filename: "conference_registration.pdf",
    content_type: "application/pdf",
    content_id: "<pdfattachment1>",
    content_disposition: "attachment",
    size: 1500,
    download_url: `file://${PDF_FILE_PATH}`,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
];

// Test 9: Multiple events in one email
const multipleEventsEmail: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-9",
      message_id: `<test-9-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Schedule for next week",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-9",
    subject: "Fwd: Schedule for next week",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Sarah Manager</strong> <span dir="auto">&lt;<a href="mailto:sarah@company.com">sarah@company.com</a>&gt;</span><br>Date: Mon, June 1, 2025 at 9:00 AM<br>Subject: Schedule for next week<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p>Hi Jon,</p><p>Here's your schedule for next week:</p><p>Monday June 8th - Team standup at 9:30 AM in Conference Room A<br>Tuesday June 9th - Client meeting at 2:00 PM to 3:30 PM (virtual on Zoom)<br>Thursday June 11th - Project review at 11:00 AM for 1 hour with the full team</p><p>Please make sure to prepare for the client meeting.</p><p>Best,<br>Sarah</p></div></div>`,
    text: `---------- Forwarded message ---------
From: Sarah Manager <sarah@company.com>
Date: Mon, June 1, 2025 at 9:00 AM
Subject: Schedule for next week
To: <${TESTER_PRIMARY_GOOGLE_ACCT}>

Hi Jon,

Here's your schedule for next week:

Monday June 8th - Team standup at 9:30 AM in Conference Room A
Tuesday June 9th - Client meeting at 2:00 PM to 3:30 PM (virtual on Zoom)
Thursday June 11th - Project review at 11:00 AM for 1 hour with the full team

Please make sure to prepare for the client meeting.

Best,
Sarah`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Schedule for next week",
      "date": "Mon, 1 Jun 2025 09:00:00 +0000",
      "message-id": `<test-9-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-9>",
      "references": "<original-message-9>",
    },
  },
);

// Test 10: Email with image attachment showing event details
const emailWithImageAttachment: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-10",
      message_id: `<test-10-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "",
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: "img-attachment-1",
          filename: "event_screenshot.jpg",
          content_type: "image/jpeg",
          size: 243331,
        },
      ],
    },
  },
  {
    id: "test-email-10",
    subject: "",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: ``,
    text: ``,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "",
      "date": "Mon, 14 Nov 2025 10:00:00 +0000",
      "message-id": `<test-10-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-10>",
      "references": "<original-message-10>",
    },
  },
);

// Add attachmentsList with download URL for image test
// Token stored in env var to avoid GitHub secret scanning flags
const IMG_TEST_FILE_TOKEN = process.env.IMG_TEST_FILE_TOKEN || "";
const IMG_BASE_URL = "https://firebasestorage.googleapis.com/v0/b/fwd2cal.firebasestorage.app/o/test%2FIMG_9444.jpg?alt=media";
emailWithImageAttachment.attachmentsList = [
  {
    id: "img-attachment-1",
    filename: "event_screenshot.jpg",
    content_type: "image/jpeg",
    size: 243331,
    content_disposition: "attachment",
    download_url: IMG_TEST_FILE_TOKEN ? `${IMG_BASE_URL}&token=${IMG_TEST_FILE_TOKEN}` : IMG_BASE_URL,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
];

// Test: Family event for Family Calendar
const familyEvent: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-family",
      message_id: `<test-family-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Family Dinner Reservation",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-family",
    subject: "Fwd: Family Dinner Reservation",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">The Ivy Restaurant</strong> <span dir="auto">&lt;<a href="mailto:reservations@theivy.com">reservations@theivy.com</a>&gt;</span><br>Date: Mon, Dec 15, 2025 at 2:30 PM<br>Subject: Family Dinner Reservation Confirmed<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p><strong>Your reservation is confirmed</strong></p><p>Saturday, December 20, 2025 at 7:00 PM</p><p>Party of 6 - Family Dinner</p><p>The Ivy Restaurant<br>1-5 West Street, London WC2H 9NQ</p></div></div>`,
    text: `
add this to my family calendar

---------- Forwarded message ---------
From: The Ivy Restaurant <reservations@theivy.com>
Date: Mon, Dec 15, 2025 at 2:30 PM
Subject: Family Dinner Reservation Confirmed
To: ${TESTER_PRIMARY_GOOGLE_ACCT}


Your reservation is confirmed

Saturday, December 20, 2025 at 7:00 PM

Party of 6 - Family Dinner

The Ivy Restaurant
1-5 West Street, London WC2H 9NQ`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Family Dinner Reservation",
      "date": "Mon, 15 Dec 2025 14:30:00 +0000",
      "message-id": `<test-family-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-family>",
      "references": "<original-message-family>",
    },
  },
);

// Test: Work event for moe@visibl.ai calendar
const workEventVisibl: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-email-work-visibl",
      message_id: `<test-work-visibl-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [MAIN_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Visibl Product Strategy Meeting",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-email-work-visibl",
    subject: "Fwd: Visibl Product Strategy Meeting",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [MAIN_EMAIL_ADDRESS],
    html: `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Sarah Chen</strong> <span dir="auto">&lt;<a href="mailto:sarah@visibl.ai">sarah@visibl.ai</a>&gt;</span><br>Date: Wed, Dec 18, 2025 at 9:15 AM<br>Subject: Visibl Product Strategy Meeting<br>To: Moe Doe &lt;<a href="mailto:moe@visibl.ai">moe@visibl.ai</a>&gt;<br>Cc: Product Team &lt;<a href="mailto:product@visibl.ai">product@visibl.ai</a>&gt;<br></div><br><p>Hi Moe,</p><p>Let's sync on the Q1 2026 product roadmap for Visibl.</p><p><strong>Meeting Details:</strong></p><p>Thursday, December 19, 2025<br>2:00 PM - 3:30 PM EST<br>Zoom: https://visibl.zoom.us/j/12345</p><p>Agenda:<br>- Review customer feedback<br>- Discuss new feature priorities<br>- Resource allocation</p><p>Best,<br>Sarah</p></div></div>`,
    text: `
add this to my visibl calendar

---------- Forwarded message ---------
From: Sarah Chen <sarah@visibl.ai>
Date: Wed, Dec 18, 2025 at 9:15 AM
Subject: Visibl Product Strategy Meeting
To: Moe Doe <moe@visibl.ai>
Cc: Product Team <product@visibl.ai>


Hi Moe,

Let's sync on the Q1 2026 product roadmap for Visibl.

Meeting Details:

Thursday, December 19, 2025
2:00 PM - 3:30 PM EST
Zoom: https://visibl.zoom.us/j/12345

Agenda:
- Review customer feedback
- Discuss new feature priorities
- Resource allocation

Best,
Sarah`,
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": MAIN_EMAIL_ADDRESS,
      "subject": "Fwd: Visibl Product Strategy Meeting",
      "date": "Wed, 18 Dec 2025 09:15:00 +0000",
      "message-id": `<test-work-visibl-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-work-visibl>",
      "references": "<original-message-work-visibl>",
    },
  },
);

// ============================================================================
// DRIVE AGENT TEST DATA
// ============================================================================

// Drive Test: Delete account (addressed to drive agent)
const driveDeleteAccount: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-drive-delete",
      message_id: `<test-drive-delete-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "delete account",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-drive-delete",
    subject: "delete account",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [DRIVE_EMAIL_ADDRESS],
    html: "",
    text: "",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": DRIVE_EMAIL_ADDRESS,
      "subject": "delete account",
      "date": "Fri, 30 May 2025 12:00:00 +0000",
      "message-id": `<test-drive-delete-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-drive-delete>",
      "references": "<original-message-drive-delete>",
    },
  },
);

// Drive Test 1: Single PDF attachment
const driveEmailWithPDF: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-drive-pdf",
      message_id: `<test-drive-pdf-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Conference Registration",
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: "drive-pdf-1",
          filename: "conference_registration.pdf",
          content_type: "application/pdf",
          content_disposition: "attachment",
          size: 15000,
        },
      ],
    },
  },
  {
    id: "test-drive-pdf",
    subject: "Fwd: Conference Registration",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [DRIVE_EMAIL_ADDRESS],
    html: "<p>Please save this to my drive.</p>",
    text: "Please save this to my drive.",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": DRIVE_EMAIL_ADDRESS,
      "subject": "Fwd: Conference Registration",
      "date": "Mon, 1 Jul 2025 09:00:00 +0000",
      "message-id": `<test-drive-pdf-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-drive-pdf>",
      "references": "<original-message-drive-pdf>",
    },
  },
);
driveEmailWithPDF.attachmentsList = [
  {
    id: "drive-pdf-1",
    filename: "conference_registration.pdf",
    content_type: "application/pdf",
    content_disposition: "attachment",
    size: 1500,
    download_url: `file://${PDF_FILE_PATH}`,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
];

// Drive Test 2: No attachments
const driveEmailNoAttachments: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-drive-noattach",
      message_id: `<test-drive-noattach-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Save this",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-drive-noattach",
    subject: "Save this",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [DRIVE_EMAIL_ADDRESS],
    html: "<p>Oops, I forgot the attachment.</p>",
    text: "Oops, I forgot the attachment.",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": DRIVE_EMAIL_ADDRESS,
      "subject": "Save this",
      "date": "Mon, 1 Jul 2025 10:00:00 +0000",
      "message-id": `<test-drive-noattach-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-drive-noattach>",
      "references": "<original-message-drive-noattach>",
    },
  },
);

// Drive Test: Signup via email (no attachments, unknown user)
const driveSignup: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-drive-signup",
      message_id: `<test-drive-signup-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Hi",
      created_at: new Date().toISOString(),
      attachments: [],
    },
  },
  {
    id: "test-drive-signup",
    subject: "Hi",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [DRIVE_EMAIL_ADDRESS],
    html: "<p>I want to sign up</p>",
    text: "I want to sign up",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": DRIVE_EMAIL_ADDRESS,
      "subject": "Hi",
      "date": "Mon, 1 Jul 2025 08:00:00 +0000",
      "message-id": `<test-drive-signup-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-drive-signup>",
      "references": "<original-message-drive-signup>",
    },
  },
);

// Drive Test 3: Multiple attachments
const driveEmailMultipleAttachments: ResendTestData = createResendTestData(
  {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: "test-drive-multi",
      message_id: `<test-drive-multi-${Date.now()}@mail.gmail.com>`,
      from: TESTER_PRIMARY_GOOGLE_ACCT,
      to: [DRIVE_EMAIL_ADDRESS],
      cc: [],
      bcc: [],
      subject: "Fwd: Project documents",
      created_at: new Date().toISOString(),
      attachments: [
        {
          id: "drive-multi-1",
          filename: "conference_registration.pdf",
          content_type: "application/pdf",
          content_disposition: "attachment",
          size: 15000,
        },
        {
          id: "drive-multi-2",
          filename: "meeting_notes.pdf",
          content_type: "application/pdf",
          content_disposition: "attachment",
          size: 15000,
        },
      ],
    },
  },
  {
    id: "test-drive-multi",
    subject: "Fwd: Project documents",
    from: TESTER_PRIMARY_GOOGLE_ACCT,
    to: [DRIVE_EMAIL_ADDRESS],
    html: "<p>Here are the project documents for Q2.</p>",
    text: "Here are the project documents for Q2.",
    headers: {
      "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
      "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
      "to": DRIVE_EMAIL_ADDRESS,
      "subject": "Fwd: Project documents",
      "date": "Mon, 1 Jul 2025 12:00:00 +0000",
      "message-id": `<test-drive-multi-${Date.now()}@mail.gmail.com>`,
      "in-reply-to": "<original-message-drive-multi>",
      "references": "<original-message-drive-multi>",
    },
  },
);
driveEmailMultipleAttachments.attachmentsList = [
  {
    id: "drive-multi-1",
    filename: "conference_registration.pdf",
    content_type: "application/pdf",
    content_disposition: "attachment",
    size: 1500,
    download_url: `file://${PDF_FILE_PATH}`,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
  {
    id: "drive-multi-2",
    filename: "meeting_notes.pdf",
    content_type: "application/pdf",
    content_disposition: "attachment",
    size: 1500,
    download_url: `file://${PDF_FILE_PATH}`,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  },
];

export {
  ResendTestData,
  AttachmentWithUrl,
  emailFromMain,
  addEmailAddress,
  addEmailAddressInBody,
  removeEmailAddress,
  deleteAccount,
  eventEmailFromSecondEmail,
  basicDetailedEmail,
  basicEmailFuture,
  emailWithICSAttachment,
  emailWithPDFAttachment,
  multipleEventsEmail,
  emailWithImageAttachment,
  familyEvent,
  workEventVisibl,
  driveDeleteAccount,
  driveSignup,
  driveEmailWithPDF,
  driveEmailNoAttachments,
  driveEmailMultipleAttachments,
};
