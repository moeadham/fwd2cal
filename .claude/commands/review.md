You are reviewing code changes against a specification.

Compare the git diff on the current branch against the spec at: $ARGUMENTS

---

## Process

1. Read the spec file provided
2. Run `git diff main...HEAD` to see all changes on this branch
3. Read every changed file in full for context

## Review Checklist

### Completeness
- Every requirement in the spec is implemented
- No steps were skipped or partially done

### Correctness
- Logic matches what the spec describes
- Edge cases called out in the spec are handled
- No off-by-one errors, wrong conditions, or swapped arguments

### Project Patterns (see AGENTS.md)
- Follows the existing agent module pattern
- Config params use `defineString`/`defineInt`, `.value()` only inside handlers
- LLM calls use `defaultCompletion` with Zod schema
- Code style: double quotes, 120 char lines, arrow functions, `_` prefix for unused params

### Bugs & Safety
- No unhandled promise rejections or missing awaits
- No secrets or credentials in code
- No accidental exposure of user data in logs or emails
- No TypeScript `any` that could hide type errors

### Unnecessary Changes
- No unrelated refactors, cleanups, or formatting changes
- No added comments, docstrings, or type annotations on unchanged code
- No new dependencies that weren't in the spec

---

## Output Format

### Summary
One paragraph: does this implementation satisfy the spec?

### Issues
List each issue found. For each:
- **File:line** — what's wrong and why
- **Severity** — blocker / warning / nit

### Verdict
PASS — ship it
PASS WITH NITS — minor issues, safe to merge
NEEDS CHANGES — blockers that must be fixed
