/* eslint-disable no-irregular-whitespace */
/* eslint-disable no-tabs */
/* eslint-disable max-len */
/* eslint-disable require-jsdoc */

const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT;
const TESTER_SECONDARY_EMAIL_ACCT = process.env.TESTER_SECONDARY_EMAIL_ACCT;

// Helper function to create Resend test data structure
function createResendTestData(webhookData, emailContent) {
  return {
    webhook: webhookData,
    emailContent: emailContent,
  };
}

// Helper function to generate authentication-results header
function generateAuthHeader(from) {
  const domain = from.split("@")[1];
  return `amazonses.com; spf=pass (spfCheck: domain of _spf.${domain} designates 209.85.214.171 as permitted sender) client-ip=209.85.214.171; envelope-from=${from}; helo=mail.${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`;
}

// Test 1: Basic forwarded email
const emailFromMain = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-1",
        message_id: `<test-1-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
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
        "to": "calendar@fwd2cal.com",
        "subject": "Fwd: Finess Clinic Appointment Confirmation",
        "date": "Tue, 26 Mar 2024 12:38:21 +0000",
        "message-id": `<test-1-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-1>",
        "references": "<original-message-1>",
      },
    },
);

// Test 2: Add email address
const addEmailAddress = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-2",
        message_id: `<test-2-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
      html: `<div dir="ltr">add ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
      text: `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
      headers: {
        "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": "calendar@fwd2cal.com",
        "subject": `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
        "date": "Thu, 28 Mar 2025 10:38:21 +0000",
        "message-id": `<test-2-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-2>",
        "references": "<original-message-2>",
      },
    },
);

// Test 3: Remove email address
const removeEmailAddress = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-3",
        message_id: `<test-3-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
      html: `<div dir="ltr">remove ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
      text: `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
      headers: {
        "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": "calendar@fwd2cal.com",
        "subject": `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
        "date": "Fri, 30 May 2025 11:00:00 +0000",
        "message-id": `<test-3-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-3>",
        "references": "<original-message-3>",
      },
    },
);

// Test 4: Delete account
const deleteAccount = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-4",
        message_id: `<test-4-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
      html: "",
      text: "",
      headers: {
        "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": "calendar@fwd2cal.com",
        "subject": "delete account",
        "date": "Fri, 30 May 2025 12:00:00 +0000",
        "message-id": `<test-4-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-4>",
        "references": "<original-message-4>",
      },
    },
);

// Test 5: Event from secondary email
const eventEmailFromSecondEmail = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-5",
        message_id: `<test-5-${Date.now()}@mail.gmail.com>`,
        from: TESTER_SECONDARY_EMAIL_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
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
        "to": "calendar@fwd2cal.com",
        "subject": "Fwd: Tottenham Hotspur v Arsenal Premier League Match",
        "date": "Thu, 25 Apr 2025 14:30:00 +0000",
        "message-id": `<test-5-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-5>",
        "references": "<original-message-5>",
      },
    },
);

// Test 6: Basic detailed email with forward
const basicDetailedEmail = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-6",
        message_id: `<test-6-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
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
        "to": "calendar@fwd2cal.com",
        "subject": "Fwd: Meet Jimmy for coffee",
        "date": "Thu, 4 Apr 2025 10:00:00 +0000",
        "message-id": `<test-6-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-6>",
        "references": "<original-message-6>",
      },
    },
);

// Test 7: Future event with date placeholder
const basicEmailFuture = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-7",
        message_id: `<test-7-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
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
        "to": "calendar@fwd2cal.com",
        "subject": "Meet Jimmy for Coffee",
        "date": "Fri, 30 May 2025 10:00:00 +0000",
        "message-id": `<test-7-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-7>",
        "references": "<original-message-7>",
      },
    },
);

// Test 8: Email with ICS attachment
const emailWithICSAttachment = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-8",
        message_id: `<test-8-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
      html: "<p>here is the ics</p>",
      text: "here is the ics",
      headers: {
        "authentication-results": generateAuthHeader(TESTER_PRIMARY_GOOGLE_ACCT),
        "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
        "to": "calendar@fwd2cal.com",
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

// Test 9: Multiple events in one email
const multipleEventsEmail = createResendTestData(
    {
      type: "email.received",
      created_at: new Date().toISOString(),
      data: {
        email_id: "test-email-9",
        message_id: `<test-9-${Date.now()}@mail.gmail.com>`,
        from: TESTER_PRIMARY_GOOGLE_ACCT,
        to: ["calendar@fwd2cal.com"],
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
      to: ["calendar@fwd2cal.com"],
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
        "to": "calendar@fwd2cal.com",
        "subject": "Fwd: Schedule for next week",
        "date": "Mon, 1 Jun 2025 09:00:00 +0000",
        "message-id": `<test-9-${Date.now()}@mail.gmail.com>`,
        "in-reply-to": "<original-message-9>",
        "references": "<original-message-9>",
      },
    },
);

module.exports = {
  emailFromMain,
  addEmailAddress,
  removeEmailAddress,
  deleteAccount,
  eventEmailFromSecondEmail,
  basicDetailedEmail,
  basicEmailFuture,
  emailWithICSAttachment,
  multipleEventsEmail,
};
