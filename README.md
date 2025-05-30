
# fwd2cal

forward an email => get calendar event

That's it. No buttons, no clicking - just forward an email, and a calendar event gets added to your Google Calendar.

fwd2cal uses an LLM to parse the thread, generate a JSON of the event details, and then adds the event to your google calendar.

[fwd2cal.com](https://www.fwd2cal.com) - running in production, free until it gets annoying/expensive to run.

https://github.com/moeadham/fwd2cal/assets/2141397/bb081bb1-9518-4cb4-8bcb-a1b6559f0eb5


You can self host - it runs on firebase functions.

## Features:

- Signup with an email: just email calendar@fwd2cal.com and you'll be sent a google auth link.
- Send from multiple email addresses: send `add myworkemail@address.com` to calendar@fwd2cal.com, and then you can add events to your google calendar from another email address
- Completely private: No logging, or storage of any emails. All that is stored are your email addresses.
- That's it. The goal is to just do one thing correctly and stay out of the way of the user.

## Self hosting setup

You will need:
1. a firebase project
2. an openAI API key with gpt4 access
3. a mailgun account setup with a domain to receive emails (recommended) OR a sendgrid account (legacy support)

```
firebase functions:config:set environment.name="production"
firebase functions:config:set environment.openai_api_key="sk-YOUR_API_KEY"
firebase functions:config:set environment.sendgrid_api_key="YOUR_API_KEY"
firebase functions:config:set environment.sendgrid_endpoint="very_hard_to_guess_endpoint"
firebase functions:config:set environment.mailgun_api_key="YOUR_API_KEY"
firebase functions:config:set environment.mailgun_endpoint="very_hard_to_guess_endpoint"
firebase functions:config:set environment.sentry_dsn="your sentry dsn"
firebase functions:config:set environment.ga_secret="GA measurement protocol 4 api key"
firebase functions:config:set environment.ga_measurement="GA measurement ID"
```

Make sure you then set the secret URL as your parse URL in mailgun (or sendgrid for legacy setups).

## Local setup

For local, edit .runtimeconfig.json
```
{
  "environment": {
    "name": "local",
    "openai_api_key": "sk-YOUR_API_KEY",
    "mailgun_api_key": "your-mailgun-api-key",
    "sendgrid_api_key": "your-sendgrid-api-key"
  }
}
```

Also - you're probably going to want to save your credentials from https://console.cloud.google.com/apis/credentials to: `functions/auth/google-auth-credentials.json`.

You want to make sure your `redirect_uris` are setup correctly. It is a list, [0] should be the default from firebase, [1] should be `http://localhost:5001/yourappname/your-region/oauthCallback`, and [2] should be the prod url.


## Testing

```
export TESTER_PRIMARY_GOOGLE_ACCT="your@gmail.com"
export TESTER_SECONDARY_EMAIL_ACCT="anotherEmailAddressThatYouUse@anything.com"
cd functions
npm test
```
Make sure you authorize your google account in 30 seconds after starting the test so the tests can run.

To test pubsub cron jobs:
```
firebase functions:shell
refreshTokensScheduled()
```
If you know how to make a test script properly send a pubsub message on the firebase emulator, a PR would be appreciated.

## Contributing

All contributions are welcome. I will do by best to keep `main` stable.

### Where you can help:

- `functions/util/prompts.js` - Prompt engineers can help here, if you notice fwd2cal fail to add your event correctly, think of adding an example to the prompt that teaches gpt4
- Timezones - I find the current prompt is bad at understanding timezones; likely worth adding another prompt only to detect the timezone.
- Multiple calendars: right now all events are added to the default calendar - but GPT4 can likely understand the context of all the users calendar and select an appropriate one.
- Get rid of all the hard coded references to fwd2cal.com so it can be self hosted easier.
- Find a way to add a test for the oAuth refresh tokens. I didn't bother
- Upgrade to firebase functions v2

## Author

This was written by [@moeadham](https://twitter.com/moeadham) to get familiar with firebase and webstudio - training for a much larger project I'm working on.
