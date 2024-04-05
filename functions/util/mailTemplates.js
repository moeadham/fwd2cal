/* eslint-disable max-len */
const mailTemplates = {
  noUserFound: {
    html:
`Welcome!<br><br>
To sign up for fwd2cal, please click the link below. This means you accept our <a href="https://fwd2cal.com/terms">terms of service</a> and <a href="https://fwd2cal.com/privacy">privacy policy</a>.<br>
<a href="https://fwd2cal.com/signup">Sign up with Google.</a><br><br>
If you forwarded an email to have it added to your calendar - you will need to do that again after signing up.<br><br>

Note: If you've already signed up for fwd2cal, and want to fwd events from this email address, send an email from your main Gmail account to <a href="mailto:calendar@fwd2cal.com">calendar@fwd2cal.com</a> with the subject "add %FROM_EMAIL%".<br>
`,
  },
  unverifiedEmail: {
    html:
`Sorry - but something is wrong with your e-mail configuration and we can't verify you're actually %FROM_EMAIL%
`,
  },
  oauthFailed: {
    html:
`Sorry - there was an issue authenticating with Google. Please click <a href="https://fwd2cal.com/signup">to authorize Google again</a>, and then forward your thread another time.`,
  },
  unableToParse: {
    html:
`Sorry - AI wasn't able to find a date in your email. Forward the thread again and include some instructions to help AI figure it out.`,
  },
  aiParseError: {
    html:
`Sorry - AI wasn't able to find a date in your email. %PARSE_ERROR_DESCRIPTION%
Forward the thread again and include some instructions to help AI figure it out.`,
  },
  eventAdded: {
    html:
`Event added to your calendar. Have a look at it <a href="%EVENT_LINK%">here</a>.
<br>Date: %EVENT_DATE%
<br>Attendees: %EVENT_ATTENDEES%`,
  },
  addAdditionalEmailAddress: {
    subject:
`%ORIGINATOR_EMAIL% would like you to add events to their calendar`,
    html:
`To join %ORIGINATOR_EMAIL%'s fwd2cal account, please click <a href="https://fwd2cal.com/auth/verifyAdditionalEmail?uuid=%VERIFICATION_CODE%">here</a><br><br>

After you approve, you can forward any email to calendar@fwd2cal.com, and it will automatically be turned into an event in %ORIGINATOR_EMAIL%'s calendar using AI.<br><br>

If not, you can ignore this email 🤷.
`,
  },
  additionalEmailInUse: {
    html:
`Sorry - but %EMAIL_TO_ADD% is already in use by another fwd2cal account. If you want to add it to this account, you'll need the current account holder to send an email to calendar@fwd2cal.com with the subject "remove %EMAIL_TO_ADD%"`,
  },
};

module.exports = {mailTemplates};

