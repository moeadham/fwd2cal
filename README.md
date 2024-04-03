
# Self hosting setup

```
firebase functions:config:set environment.name="production"
firebase functions:config:set environment.openai_api_key="sk-YOUR_API_KEY"
firebase functions:config:set environment.sendgrid_endpoint="very_hard_to_guess_endpoint"
```

Make sure you then set the secret URL as your parse URL in sendgrid.
I would also have a look at the redirect URL in firestore.json for `/signup`


# Local setup

For local, edit .runtimeconfig.json
```
{
  "environment": {
    "name": "local",
    "openai_api_key": "sk-YOUR_API_KEY",
    "sendgrid_api_key": "your-sendgrid-api-key",
  }
}
```

Also - you're probably going to want to save your credentials from https://console.cloud.google.com/apis/credentials to: `functions/auth/google-auth-credentials.json`.

You want to make sure your `redirect_uris` are setup correctly. It is a list, [0] should be the default from firebase, [1] should be `http://localhost:5001/yourappname/your-region/oauthCallback`, and [2] should be your the prod url.


# Testing

```
cd functions
npm run test
```

To test pubsub cron jobs:
```
firebase functions:shell
refreshTokensScheduled()
```
If you know how to make a test script properly send a pubsub message on the firebase emulator, a PR would be appreciated.