/* eslint-disable no-irregular-whitespace */
/* eslint-disable no-tabs */
/* eslint-disable max-len */

const TESTER_PRIMARY_GOOGLE_ACCT = process.env.TESTER_PRIMARY_GOOGLE_ACCT;
const TESTER_SECONDARY_EMAIL_ACCT = process.env.TESTER_SECONDARY_EMAIL_ACCT;

const emailFromMain = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "Fwd: Finess Clinic Appointment Confirmation",
  "body-plain": `---------- Forwarded message ---------
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
  "body-html": `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Finess Clinic</strong> <span dir="auto">&lt;<a href="mailto:noreply@treatwell.co.uk">noreply@treatwell.co.uk</a>&gt;</span><br>Date: Tue, Mar 26, 2024 at 11:04 AM<br>Subject: Finess Clinic Appointment Confirmation<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p><strong>Your booking is confirmed</strong></p><p>Order reference: W1503268392</p><p><strong>Your appointment</strong></p><p>Wednesday, 26 March 2025, 11:15 AM</p><p>Acupuncture<br>30 minutes session</p><p>Amount to pay at the salon<br>£45.00</p><p>Finess Clinic<br>Suite 1, Beatty House, Admirals Way, Canary Wharf, London, UK, E14 9UF</p></div></div>`,
  "stripped-text": `Your booking is confirmed

Order reference: W1503268392

Your appointment

Wednesday, 26 March 2025, 11:15 AM

Acupuncture
30 minutes session

Amount to pay at the salon
£45.00

Finess Clinic
Suite 1, Beatty House, Admirals Way, Canary Wharf, London, UK, E14 9UF`,
  "stripped-html": `<p><strong>Your booking is confirmed</strong></p><p>Order reference: W1503268392</p><p><strong>Your appointment</strong></p><p>Wednesday, 26 March 2025, 11:15 AM</p><p>Acupuncture<br>30 minutes session</p><p>Amount to pay at the salon<br>£45.00</p><p>Finess Clinic<br>Suite 1, Beatty House, Admirals Way, Canary Wharf, London, UK, E14 9UF</p>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Tue, 26 Mar 2024 12:38:21 +0000"],["Subject","Fwd: Finess Clinic Appointment Confirmation"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"00000000000000ec3306364540e0\\""]]`,
  "timestamp": "1711454301",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const addEmailAddress = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "body-plain": `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "body-html": `<div dir="ltr">add ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
  "stripped-text": `add ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "stripped-html": `<div dir="ltr">add ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Thu, 28 Mar 2025 10:38:21 +0000"],["Subject","add ${TESTER_SECONDARY_EMAIL_ACCT}"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary123\\""]]`,
  "timestamp": "1711622301",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const eventEmailFromSecondEmail = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_SECONDARY_EMAIL_ACCT,
  "from": `Jon Doe <${TESTER_SECONDARY_EMAIL_ACCT}>`,
  "subject": "Fwd: Tottenham Hotspur v Arsenal Premier League Match",
  "body-plain": `---------- Forwarded message ---------
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
  "body-html": `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Tottenham Hotspur</strong> <span dir="auto">&lt;<a href="mailto:noreply@tottenhamhotspur.com">noreply@tottenhamhotspur.com</a>&gt;</span><br>Date: Wed, Apr 24, 2025 at 2:30 PM<br>Subject: Tottenham Hotspur v Arsenal Premier League Match<br>To: &lt;<a href="mailto:${TESTER_SECONDARY_EMAIL_ACCT}">${TESTER_SECONDARY_EMAIL_ACCT}</a>&gt;<br></div><br><p><strong>TOTTENHAM HOTSPUR V ARSENAL</strong></p><p>Premier League</p><p>Sunday 28 April 2025</p><p>Kick-off: 2pm</p><p>Your tickets will remain valid for this fixture.</p><p>Tottenham Hotspur Stadium</p></div></div>`,
  "stripped-text": `TOTTENHAM HOTSPUR V ARSENAL

Premier League

Sunday 28 April 2025

Kick-off: 2pm

Your tickets will remain valid for this fixture.

Tottenham Hotspur Stadium`,
  "stripped-html": `<p><strong>TOTTENHAM HOTSPUR V ARSENAL</strong></p><p>Premier League</p><p>Sunday 28 April 2025</p><p>Kick-off: 2pm</p><p>Your tickets will remain valid for this fixture.</p><p>Tottenham Hotspur Stadium</p>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_SECONDARY_EMAIL_ACCT}>"],["Date","Thu, 25 Apr 2025 14:30:00 +0000"],["Subject","Fwd: Tottenham Hotspur v Arsenal Premier League Match"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary456\\""]]`,
  "timestamp": "1714056600",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const basicDetailedEmail = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "Fwd: Meet Jimmy for coffee",
  "body-plain": `---------- Forwarded message ---------
From: Jimmy <jimmy@example.com>
Date: Thu, Apr 4, 2025 at 10:00 AM
Subject: Meet Jimmy for coffee
To: <${TESTER_PRIMARY_GOOGLE_ACCT}>

Hey!

Let's meet for coffee at Starbucks on Friday April 4th at 1pm.

Thanks,
Jimmy`,
  "body-html": `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Jimmy</strong> <span dir="auto">&lt;<a href="mailto:jimmy@example.com">jimmy@example.com</a>&gt;</span><br>Date: Thu, Apr 4, 2025 at 10:00 AM<br>Subject: Meet Jimmy for coffee<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p>Hey!</p><p>Let's meet for coffee at Starbucks on Friday April 4th at 1pm.</p><p>Thanks,<br>Jimmy</p></div></div>`,
  "stripped-text": `Hey!

Let's meet for coffee at Starbucks on Friday April 4th at 1pm.

Thanks,
Jimmy`,
  "stripped-html": `<p>Hey!</p><p>Let's meet for coffee at Starbucks on Friday April 4th at 1pm.</p><p>Thanks,<br>Jimmy</p>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Thu, 4 Apr 2025 10:00:00 +0000"],["Subject","Fwd: Meet Jimmy for coffee"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary789\\""]]`,
  "timestamp": "1712318400",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const basicEmailFuture = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "Meet Jimmy for Coffee",
  "body-plain": `
  ---------- Forwarded message ---------
    From: Gill Bates <${TESTER_SECONDARY_EMAIL_ACCT}>
    Date: Tue, Mar 21, 2025 at 11:04 AM
    Subject: meet jimmy for coffee
    To: <${TESTER_PRIMARY_GOOGLE_ACCT}>
    
    Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%
    
    Gill.`,
  "body-html": `<div dir="ltr"><p>Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%</p><p>Gill.</p></div>`,
  "stripped-text": `Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%

Gill.`,
  "stripped-html": `<p>Hey Jon, lets both meet at starbucks, 12pm %DATE_IN_THE_FUTURE%</p><p>Gill.</p>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Fri, 30 May 2025 10:00:00 +0000"],["Subject","Meet Jimmy for Coffee"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary012\\""]]`,
  "timestamp": "1748579200",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const removeEmailAddress = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "body-plain": `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "body-html": `<div dir="ltr">remove ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
  "stripped-text": `remove ${TESTER_SECONDARY_EMAIL_ACCT}`,
  "stripped-html": `<div dir="ltr">remove ${TESTER_SECONDARY_EMAIL_ACCT}</div>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Fri, 30 May 2025 11:00:00 +0000"],["Subject","remove ${TESTER_SECONDARY_EMAIL_ACCT}"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary345\\""]]`,
  "timestamp": "1748582800",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const deleteAccount = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "delete account",
  "body-plain": "",
  "body-html": "",
  "stripped-text": "",
  "stripped-html": "",
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Fri, 30 May 2025 12:00:00 +0000"],["Subject","delete account"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary678\\""]]`,
  "timestamp": "1748586400",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

const emailWithICSAttachment = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "email with ics attachment",
  "body-plain": "here is the ics",
  "body-html": "<p>here is the ics</p>",
  "stripped-text": "here is the ics",
  "stripped-html": "<p>here is the ics</p>",
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Thu, 28 Mar 2025 10:38:21 +0000"],["Subject","email with ics attachment"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/mixed; boundary=\\"----mailgun-boundary-123\\""]]`,
  "timestamp": "1711622313",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
  "attachment-count": "1",
};

const multipleEventsEmail = {
  "recipient": "calendar@fwd2cal.com",
  "sender": TESTER_PRIMARY_GOOGLE_ACCT,
  "from": `Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>`,
  "subject": "Fwd: Schedule for next week",
  "body-plain": `---------- Forwarded message ---------
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
  "body-html": `<div dir="ltr"><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Sarah Manager</strong> <span dir="auto">&lt;<a href="mailto:sarah@company.com">sarah@company.com</a>&gt;</span><br>Date: Mon, June 1, 2025 at 9:00 AM<br>Subject: Schedule for next week<br>To: &lt;<a href="mailto:${TESTER_PRIMARY_GOOGLE_ACCT}">${TESTER_PRIMARY_GOOGLE_ACCT}</a>&gt;<br></div><br><p>Hi Jon,</p><p>Here's your schedule for next week:</p><p>Monday June 8th - Team standup at 9:30 AM in Conference Room A<br>Tuesday June 9th - Client meeting at 2:00 PM to 3:30 PM (virtual on Zoom)<br>Thursday June 11th - Project review at 11:00 AM for 1 hour with the full team</p><p>Please make sure to prepare for the client meeting.</p><p>Best,<br>Sarah</p></div></div>`,
  "stripped-text": `Hi Jon,

Here's your schedule for next week:

Monday June 8th - Team standup at 9:30 AM in Conference Room A
Tuesday June 9th - Client meeting at 2:00 PM to 3:30 PM (virtual on Zoom)
Thursday June 11th - Project review at 11:00 AM for 1 hour with the full team

Please make sure to prepare for the client meeting.

Best,
Sarah`,
  "stripped-html": `<p>Hi Jon,</p><p>Here's your schedule for next week:</p><p>Monday June 8th - Team standup at 9:30 AM in Conference Room A<br>Tuesday June 9th - Client meeting at 2:00 PM to 3:30 PM (virtual on Zoom)<br>Thursday June 11th - Project review at 11:00 AM for 1 hour with the full team</p><p>Please make sure to prepare for the client meeting.</p><p>Best,<br>Sarah</p>`,
  "message-headers": `[["X-Mailgun-Spf","Pass"],["X-Mailgun-Dkim-Check-Result","Pass"],["From","Jon Doe <${TESTER_PRIMARY_GOOGLE_ACCT}>"],["Date","Mon, 1 Jun 2025 09:00:00 +0000"],["Subject","Fwd: Schedule for next week"],["To","calendar@fwd2cal.com"],["Content-Type","multipart/alternative; boundary=\\"boundary901\\""]]`,
  "timestamp": "1748854800",
  "token": "dummy_mailgun_token_for_testing_purposes_only",
  "signature": "dummy_mailgun_signature_for_testing_purposes_only",
};

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
