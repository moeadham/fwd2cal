
# fwd2cal

forward an email => get calendar event

That's it. No buttons, no clicking - just forward an email, and a calendar event gets added to your Google Calendar.

fwd2cal uses an LLM to parse the thread, generate a JSON of the event details, and then adds the event to your google calendar.

[fwd2cal.com](https://www.fwd2cal.com) - running in production, free until it gets annoying/expensive to run.

https://github.com/moeadham/fwd2cal/assets/2141397/bb081bb1-9518-4cb4-8bcb-a1b6559f0eb5


You can self host - it runs on firebase functions.

## Features:

- Signup with an email: just email calendar@fwd2cal.com and you'll be sent a google auth link.
- Send from multiple email addresses: send `add myworkemail@address.com` in the subject line to calendar@fwd2cal.com, and then you can add events to your google calendar from another email address
- ICS attachment support: Forward emails with .ics calendar attachments to automatically add them to your calendar
- Multi-event extraction: Extract and add multiple events from a single email
- Sensible durations: Most emails only give a start time. Rather than defaulting every event to the same length, the event duration is inferred from what kind of event it is - a dinner reservation gets two hours, a coffee gets thirty minutes. If no duration can be inferred, your own Google Calendar "default event length" setting is used.
- Email threading: Replies appear in the same email thread for better organization
- Completely private: No logging, or storage of any emails. All that is stored are your email addresses.
- That's it. The goal is to just do one thing correctly and stay out of the way of the user.

## Self hosting setup

You will need:
1. a firebase project
2. an OpenRouter API key (for LLM access)
3. a Resend account for sending and receiving emails

When you deploy or run the emulator `firebase emulators:start`, Firebase will prompt you to set the required parameters:
- `OPENROUTER_API_KEY` - Your OpenRouter API key
- `RESEND_API_KEY` - Your Resend API key
- `RESEND_SIGNING_SECRET` - Resend webhook signing secret
- `POSTHOG_API_KEY` - (Optional) PostHog API key for analytics
- `ENVIRONMENT_NAME` - (Optional) Defaults to "production"

Configure Resend to forward incoming emails to your Firebase Functions webhook:
- In your Resend dashboard, set up email forwarding to: `https://{your project name}.web.app/v2/resendInboundCallback`
- be sure to copy the RESEND_SIGNING_SECRET after you set your callback url
- Make sure to configure your domain's DNS records in Resend to receive emails

## Local setup

Create a `functions/.env` file with your local development credentials:
```bash
# Environment Configuration
ENVIRONMENT_NAME=local

# API Keys
OPENROUTER_API_KEY=sk-or-v1-YOUR_API_KEY

# Resend
RESEND_API_KEY=re_YOUR_API_KEY
RESEND_SIGNING_SECRET=whsec_YOUR_SECRET

# PostHog Analytics (optional)
POSTHOG_API_KEY=phc_YOUR_API_KEY
```

Also - you're probably going to want to save your credentials from https://console.cloud.google.com/apis/credentials to: `functions/auth/v2-google-auth-credentials.json`.

You want to make sure your `redirect_uris` are setup correctly. It is a list, [0] should be the default from firebase, [1] should be `http://127.0.0.1:5002/v2/oauthCallback` for local development, and [2] should be the prod url.


## Testing

```bash
export TESTER_PRIMARY_GOOGLE_ACCT="your@gmail.com"
export TESTER_SECONDARY_EMAIL_ACCT="anotherEmailAddressThatYouUse@anything.com"
cd functions
npm test
```
Make sure you authorize your google account in 30 seconds after starting the test so the tests can run.

The test suite uses a mock Resend client to simulate email sending and receiving without making actual API calls.

To test scheduled functions (note: token refresh is currently disabled):
```bash
firebase functions:shell
v2refreshTokensScheduled()
```

## Contributing

All contributions are welcome. I will do by best to keep `main` stable.

### Where you can help:

- `functions/util/prompts.js` - Prompt engineers can help here. If you notice fwd2cal fail to add your event correctly, consider adding examples to the prompts to improve the AI's understanding.
- Timezones - The current timezone detection could be improved for better accuracy across different formats and locations.
- Multiple calendars: Right now all events are added to the default calendar - the AI could potentially understand context and select an appropriate calendar.
- Find a way to add a test for the oAuth refresh tokens.

## Author

This was written by [@moeadham](https://twitter.com/moeadham) to get familiar with firebase and structured data from LLMs - training for a much larger project I'm working on.
