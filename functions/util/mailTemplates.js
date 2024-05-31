/* eslint-disable max-len */
const mailTemplates = {
  noUserFound: {
    html:
`Welcome!<br><br>
To sign up for fwd2cal, please click the link below.<br><br>
<a href="https://www.fwd2cal.com/signup-consent"><img src="https://app.fwd2cal.com/signup-with-google.png" alt="Sign Up with Google" width="182" height="42" style="display: block;"></a><br><br>
If you forwarded an email to have it added to your calendar - you will need to do that again after signing up.<br><br>

Note: If you've already signed up for fwd2cal, and want to fwd events from this email address, send an email from your main Gmail account to <a href="mailto:calendar@fwd2cal.com?subject=add %FROM_EMAIL%">calendar@fwd2cal.com</a> with the subject "add %FROM_EMAIL%".<br>
`,
  },
  unverifiedEmail: {
    html:
`Sorry - but something is wrong with your e-mail configuration and we can't verify you're actually %FROM_EMAIL%.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a>
`,
  },
  oauthFailed: {
    html:
`Sorry - there was an issue authenticating with Google. Please click <a href="https://app.fwd2cal.com/signup">to authorize Google again</a>, and then forward your thread another time.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  unableToParse: {
    html:
`Sorry - AI wasn't able to find a date in your email. Forward the thread again and include some instructions to help AI figure it out.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  aiParseError: {
    html:
`Sorry - AI wasn't able to find a date in your email. %PARSE_ERROR_DESCRIPTION%
Forward the thread again and include some instructions to help AI figure it out.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  eventAddedICS: {
    html:
`The email you forwarded had an ICS file. This event has been added to your calendar:
<br><a href="%EVENT_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View Event</a>

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  icsError: {
    html:
`The email you forwarded had an ICS file. But there was an error processing it.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  eventAdded: {
    html:
`Event added to your calendar.
<br>Date: %EVENT_DATE%
<br>Attendees: %EVENT_ATTENDEES%
<br><a href="%EVENT_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View Event</a>

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  eventAddedAttendees: {
    html:
`Event added to your calendar.
<br>Date: %EVENT_DATE%
<br> <a href="%EVENT_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">View Event</a>
<br> You may want to invite:
<br>- %EVENT_ATTENDEES%
<br><a href="%INVITE_LINK%" style="display:inline-block; padding:10px 20px; margin:5px 0; background-color:#3498db; color:white; text-align:center; text-decoration:none; font-weight:bold; border-radius:5px; border:none; cursor:pointer;">Invite Guests</a>

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  addAdditionalEmailAddress: {
    subject:
`%ORIGINATOR_EMAIL% would like you to add events to their calendar`,
    html:
`To join %ORIGINATOR_EMAIL%'s fwd2cal account, please click <a href="https://app.fwd2cal.com/auth/verifyAdditionalEmail?uuid=%VERIFICATION_CODE%">here</a><br><br>

After you approve, you can forward any email to calendar@fwd2cal.com, and it will automatically be turned into an event in %ORIGINATOR_EMAIL%'s calendar using AI.<br><br>

If not, you can ignore this email 🤷.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a>
`,
  },
  additionalEmailInUse: {
    html:
`Sorry - but %EMAIL_TO_ADD% is already in use by another fwd2cal account. If you want to add it to this account, you'll need the current account holder to send an email to calendar@fwd2cal.com with the subject "remove %EMAIL_TO_ADD%"

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  removalEmailInUse: {
    html:
`Sorry - but %EMAIL_TO_REMOVE% is in use by another fwd2cal account, not your account."

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  emailAddressRemoved: {
    html:
`%EMAIL_TO_REMOVE% has been removed from your account.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
  userDeleted: {
    html:
`Sorry to see you go! Your account has been completely deleted. You can always sign up again by sending an email to <a href="mailto:calendar@fwd2cal.com?subject=signup">calendar@fwd2cal.com</a>.<br><br>

You may want disconnect fwd2cal from google <a href="https://myaccount.google.com/connections">here</a>.

<br><br>You can always ask for help: <a href="mailto:support@fwd2cal.com">support@fwd2cal.com</a><br>`,
  },
};

module.exports = {mailTemplates};

