/* eslint-disable max-len */
const messages = {
  newUser: {
    text:
`Welcome!

To sign up for fwd2cal, please click the link below. This means you accept our terms (fwd2cal.com/terms) of service and privacy policy (fwd2cal.com/privacy).

Sign up with google: https://fwd2cal.com/auth/google

If you forwarded an email to have it added added to your calendar - you will need to do that again after signing up.

Note: If you've already signed up for fwd2cal, and you want to add events to your calendar from this email address, you can do so by sending an email from your main gmail account to calendar@fwd2cal.com with the subject "add %FROM_EMAIL%". We'll take it form there.    
`,
    html:
`<p>Welcome!</p>

<p>To sign up for fwd2cal, please click the link below. This means you accept our <a href="https://fwd2cal.com/terms">terms of service</a> and <a href="https://fwd2cal.com/privacy">privacy policy</a>.</p>

<p><a href="https://fwd2cal.com/auth/google">Sign up with Google.</a></p>

<p>If you forwarded an email to have it added to your calendar - you will need to do that again after signing up.</p>

<p>Note: If you've already signed up for fwd2cal, and you want to add events to your calendar from this email address, you can do so by sending an email from your main Gmail account to <a href="mailto:calendar@fwd2cal.com">calendar@fwd2cal.com</a> with the subject "add %FROM_EMAIL%". We'll take it from there.</p>
`},
  unverifiedEmail: {
    text:
`Sorry - but something is wrong with your e-mail configuration and we can't verify you're actually %FROM_EMAIL%
`,
  },
};

module.exports = {messages};

