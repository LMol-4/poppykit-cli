# CLI reference

Run `poppykit --help` for commands and [usage](docs/usage.md) for configuration,
secret custody, hosted enrollment, authentication, profiles and exit codes.

`@poppykit/cli` exports the `SecureBackend` type, `encryptedBackend`,
`windowsBackend`, `hiddenInput`, `terminalTrustedInput` and `CliFailure`. The installed
`dist/index.d.ts` and `dist/secrets.d.ts` declarations define the complete seam.
A trusted local module exports `open({purpose,unattended})` returning durable
`secrets` and a `healthCheck`. Optional enrollment authentication, trusted
input, local signer, browser controller, business consent and transport remain private operator code.
The backend example in usage is an integration outline: `operatorVault` and
`operatorLogin` are adapters supplied by your application, not bundled services.

Commands never accept Mediated passwords/codes or business approval as flags. API commands preserve opaque business response bytes as base64; credentials and raw remote diagnostics remain outside the public error envelope. Browser
joining requires an isolated agent-controlled controller. A company/provider URL
cannot select a module to execute.

`--json` emits one version-1 envelope on stdout. Approval progress goes to stderr;
neither stream contains stored credentials or raw provider/OS diagnostics.
Protocol `read`/`watch` data and extension fields retain their original JSON values,
including business fields named `secret`, `authorization` or `credential`.
Named consumers return the CLI acknowledgment token as top-level `delivery`,
outside `result`, so a protocol extension of that name is preserved. Pass that
token to `ack`; `result.delivery` belongs to the protocol page if present.
Likewise CLI send/retry handles are top-level `sendOperation`; a company extension
of that name stays inside `result`. Human output includes the whole envelope
when those CLI handles are present.
Opaque protocol `outcome` extensions do not classify CLI authorization or process
exit codes; those statuses come from the enrollment/authentication commands.
Local `status HANDLE` exposes public destination/binding metadata and omits the
vault enrollment reference, as other public profile/auth envelopes do.

Typed failures can add `requiredScopes`, `retryAfterMs`, `retryAt`, `conversationId`
and `extensions` to `error`. Only SDK-validated fields are projected; raw error
bodies, headers and descriptions are omitted. For example:

```json
{"version":1,"command":"send","status":"error","sendOperation":"task1","error":{"code":"insufficient_scope","requiredScopes":["record:edit"]},"requestId":"local-invocation-id"}
```

Combine the existing `scopes` result's `grantedScopes` with `error.requiredScopes`
and request that union through `auth-start --scope ... --json`. Wait for the
human decision, then `poppykit retry task1 --json`. Use the same profile and saved
conversation; an upgrade never grants itself. Denial retains previous access.
Terminal Direct outcomes retire obsolete CLI references on restart; pending and
uncertain operations retain their recovery material. Cleanup failure is safe to
retry and never triggers another one-time redemption.
`retryAt` is an exact decimal epoch-millisecond string; it can exceed JavaScript's
safe numeric range. A saved enrollment result with `enrollment_finalize_required`
(exit 6) needs local finalization with `enroll`, which never retrieves it again.

Business controls use a distinct `attemptId` inside `result`, separate from auth
operation IDs and `sendOperation`. `BusinessBackend` and `OperationReview` are
exported types. Optional `SecureBackend.business` supplies trusted
`confirm(input,signal)`, `checkTerms(request,operation)` and
`reconcile(input,signal)`. Never accept model-produced consent or reconciliation.
The default console UI displays complete inert Company, summary, terms, request,
expiry, profile and authority data and requires a fresh random confirmation phrase.
It never reads an approve flag, stdin or environment variable.

API requests support GET/HEAD/POST/PUT/PATCH/DELETE and optional `--body-file`;
bytes remain exact. Mutations accept caller-chosen `--new-action ID` for a deliberate
second action; reuse that ID and exact inputs after lost responses. Changed inputs
fail with exit 5. Unresolved work cannot be bypassed by selecting another ID.
`operation-list` returns only `{attemptId,status}` entries for active records;
`operation-retire HANDLE` frees a slot only for terminal records, preserving old-handle
and identity fences. Retired status and same-identity API replay have exit 0; execution commands on
retired handles have exit 5.
Ordinary GET/HEAD failures are retryable (HTTP failure exit 1, permission errors
retain authorization exits); HTTP202 reads return `pending`, exit 0. Approval-bearing
reads retain approval/authority fencing. See [usage](docs/usage.md#business-operations).
Successful responses return
`{status:"completed",result:{status:HTTP_STATUS,body:BASE64}}`. Approval-required
403 returns `{status:"operation_required",attemptId,operation,request,nextAction}`,
exit 7. Approved, declined, withdrawn, expired and interrupted decisions retain
their actual status and exit 7; uncertain sends exit 6; completed results exit 0.
Typed `operation_*` errors use exits 2/4/5/6 as appropriate. Cancellation exits 130
and preserves recovery state. `result.retryAt` is an epoch-millisecond number;
the auth error field `error.retryAt` remains its exact decimal string.

`OperationReview` also includes the immutable `operation` (ID, revision, terms, expiry) and bound `context`. Trusted website adapters must compare them with Company records. `business-backend --module ABSOLUTE_PATH` selects a local module exporting `confirm` and optional `checkTerms`/`reconcile`; it receives no credential store and preserves the configured native/secure backend. It is loaded only for review/reconciliation; loading failures return exit 4.

For conversation actions, the reconciliation input includes `readConversation(cursor?)`. It reads the saved conversation through SDK authentication pinned to the original business authority, without revealing credentials. Inspect an actual durable Company receipt; model text is not a reconciliation result. Other channels do not receive this capability.
