
# Firebase setup

```
firebase functions:config:set environment.name="production"
firebase functions:config:set environment.openai_api_key="sk-YOUR_API_KEY"
```

For local, edit .runtimeconfig.json
```
{
  "environment": {
    "name": "local",
    "openai_api_key": "sk-YOUR_API_KEY"
  }
}
```