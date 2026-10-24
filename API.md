# CLI reference

Run `poppykit --help` for commands and [usage](docs/usage.md) for configuration,
secret custody, hosted enrollment, authentication, profiles and exit codes.

`@poppykit/cli` exports the `SecureBackend` type, `encryptedBackend`,
`windowsBackend`, `hiddenInput`, `terminalTrustedInput` and `CliFailure`. The installed
`dist/index.d.ts` and `dist/secrets.d.ts` declarations define the complete seam.
A trusted local module exports `open({purpose,unattended})` returning durable
`secrets` and a `healthCheck`. Optional enrollment authentication, trusted
input, local signer, browser controller and transport remain private operator code.
The backend example in usage is an integration outline: `operatorVault` and
`operatorLogin` are adapters supplied by your application, not bundled services.

Commands never accept Mediated passwords/codes as flags. API commands return
status/target metadata rather than private response bodies/headers. Browser
joining requires an isolated agent-controlled controller. A company/provider URL
cannot select a module to execute.

`--json` emits one version-1 envelope on stdout. Approval progress goes to stderr;
neither stream contains stored credentials or raw provider/OS diagnostics.
Protocol `read`/`watch` data and extension fields retain their original JSON values,
including business fields named `secret`, `authorization` or `credential`.

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
