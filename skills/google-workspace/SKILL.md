---
name: google-workspace
description: Use your own Google account to find, summarize and draft Gmail messages; read or create Calendar events; read Drive and Sheets.
requires: []
---

# Google Workspace

## Set up

Install the `gws` CLI and run `gws auth login` with **your own Google account**. Grant the scopes required for the requested operation in your account. Do not request or expose credentials in chat.

Run commands from this skill directory so the bundled wrapper resolves by relative path:

```bash
bash scripts/gws-safe.sh gmail users messages list --params '{"userId":"me","q":"is:unread","maxResults":10}'
```

Use `scripts/gws-safe.sh` for API calls, not `gws` directly. The wrapper removes proxy variables, strips the keyring banner before JSON output, and checks the API method against `gws schema` before running it. A read with an unknown method is blocked too; do not bypass the check. `gws schema <service.resource.method>` can be used to inspect the method locally.

## Supported work

- Gmail: find messages, read and summarize their contents, compose a draft in the reply, or save an approved draft in Gmail. Saving a draft is a write and requires the write gate below.
- Calendar: look up events and create events after confirming their details with the user.
- Drive and Sheets: read files and spreadsheet data. Do not edit them without an explicit request.

For example, read Calendar events with `bash scripts/gws-safe.sh calendar events list --params '{"calendarId":"primary"}'`. Check the relevant API schema and required parameters before issuing other calls. Treat API errors as errors, not as empty results.

## Write gate and user confirmation

Before sending email, deleting anything, or performing another irreversible action, ask the user for explicit confirmation of the **specific action and its targets**. Creating Calendar events and saving Gmail drafts also writes to the account: confirm the details before doing either. The wrapper rejects POST, PUT, PATCH, DELETE and unknown methods with exit code 4 by default; it is not permission to silently enable writes.

For each write, first inspect `gws schema <service.resource.method>` and prepare the exact wrapper command, including recipient or calendar, content, and parameters. Show those details to the user and wait for their explicit approval of **that command**. Only after that approval, run the same command yourself from this skill directory with the one-command prefix `ELANOUS_GWS_ALLOW_WRITE=1 bash scripts/gws-safe.sh ...`. Check the JSON response for errors and report the result; do not reuse approval for another command, silently change its arguments, leave the variable enabled for later calls, or bypass the wrapper. If the user does not approve, do not execute the write.
