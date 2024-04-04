/* eslint-disable max-len */
const mailTemplates = {
  noUserFound: {
    html:
`Welcome!<br><br>
To sign up for fwd2cal, please click the link below. This means you accept our <a href="https://fwd2cal.com/terms">terms of service</a> and <a href="https://fwd2cal.com/privacy">privacy policy</a>.<br>
<a href="https://fwd2cal.com/auth/google">Sign up with Google.</a><br><br>
If you forwarded an email to have it added to your calendar - you will need to do that again after signing up.<br><br>

Note: If you've already signed up for fwd2cal, and want to fwd events from this email address, send an email from your main Gmail account to <a href="mailto:calendar@fwd2cal.com">calendar@fwd2cal.com</a> with the subject "add %FROM_EMAIL%".<br>
`},
  unverifiedEmail: {
    html:
`Sorry - but something is wrong with your e-mail configuration and we can't verify you're actually %FROM_EMAIL%
`,
  },
  oauthFailed: {
    html:
`Sorry - there was an issue authenticating with google. Please go to https://fwd2cal.com/auth/google, and then forward your thread again.`,
  },
  unableToParse: {
    html:
`Sorry - AI wasn't able to find a date in your email. Forward the thread again and include some instructions to help AI figure it out.`,
  },
  eventAdded: {
    html:
`Event added to your calendar. Have a look at it <a href="%EVENT_LINK%">here</a>.
<br>Date: %EVENT_DATE%
<br>Attendees: %EVENT_ATTENDEES%`,
  },
};

module.exports = {mailTemplates};

