# fwd2cal — Agent Reference

Two email-based agents on Firebase Functions v2:
- **calendar** (fwd2cal.com) — forward an email, get a Google Calendar event
- **drive** (fwd2drive.com) — forward an email, get files organized in Google Drive

## Stack

Node 22, TypeScript 5.7, Firebase Functions v2, Firestore, Google APIs (Calendar, Drive), OpenRouter LLM, Resend email, Zod validation.

## Commands

All commands run from `functions/`:

| Task | Command |
|------|---------|
| Build | `npm run build` |
| Test (calendar) | `npm test` |
| Test (drive) | `npm run test:drive` |
| Lint | `npm run lint` |
| Serve | `npm run serve:calendar` / `npm run serve:drive` |
| Deploy | `npm run deploy` (both) / `npm run deploy:calendar` / `npm run deploy:drive` |

## Project Structure

```
functions/src/
  index.ts                    # Entry — re-exports from agent routes
  agents/
    calendar/                 # Calendar agent
    drive/                    # Drive agent
  skills/shared/              # Skills shared across agents
  util/                       # Shared utilities
  auth/                       # OAuth handling
  resend/                     # Resend webhook utils
```

## Agent Module Pattern

Each agent (`agents/calendar/`, `agents/drive/`) follows the same structure:

| File | Purpose |
|------|---------|
| `routes.ts` | HTTP endpoints (Firebase Functions v2 `onRequest`, `onTaskDispatched`, `onSchedule`) |
| `config.ts` | Agent-specific params (email address, hosting URL, signing secret) |
| `types.ts` | Agent-specific TypeScript types |
| `skills/` | Agent-specific skills, each in its own directory with a `SKILL.md` |
| `llm.ts` | LLM call wrappers |
| `prompts.ts` | System/user prompts |
| `mailTemplates.ts` | HTML email response templates |

## Key Patterns

- **Config params**: `defineString`/`defineInt` from `firebase-functions/params`. Call `.value()` only inside function handlers, never at module scope. Shared params in `util/config.ts`, agent-specific in `agents/<name>/config.ts`.
- **LLM calls**: `defaultCompletion(messages, model, temp, zodSchema)` in `util/openai.ts`. Always pass a Zod schema for structured output.
- **Email templates**: `applyTemplate()` for HTML email rendering with placeholder replacements.
- **Email threading**: Drive agent uses `sendDriveEmailResponse()` to maintain thread continuity.
- **Embedded data in emails**: Base64url-encoded JSON embedded in HTML links for stateless round-trips. Large payloads stored in Firestore `OrganizeProposals` collection.
- **Skills**: Defined by `SKILL.md` files with YAML frontmatter (`name`, `description`, `triggers`, `fastPattern` regex). Parsed at runtime with `gray-matter`. Matched via `util/skills/matcher.ts`.
- **Drive agent markers**: Agent-managed folders use `.sorted.by.fwd2drive.com` marker files.
- **OAuth**: Tokens stored in Firestore `Users` collection. `drive.file` scope for uploads, full `drive` scope for organize-drive. Separate signup endpoint for full scope.

## Code Style

- ESLint with Google config
- Double quotes, 120 char line limit
- Prefix unused params with `_`
- Arrow functions preferred
- ES2022 target, CommonJS modules
- `strictNullChecks` is OFF

## Testing

- Every new feature or bug fix must include a test case
- Mocha + Chai, runs against Firebase emulator
- Mock Resend client available (`util/resendMock.ts`)
- Test env vars loaded from `functions/.env.local`
