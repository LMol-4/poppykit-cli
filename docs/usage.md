# CLI configuration and operations

Install Node 24 >=24.21.0 (24.x only) and the CLI using [README](../README.md). The client dependency
is installed by npm; no server SDK, daemon or browser opener is needed.
Native defaults need no backend configuration on Windows/macOS or a
[prepared Linux desktop](linux.md). Use actual
provider/company URLs; configure a module only for a custom backend:

```sh
poppykit setup --provider https://identity.example/v1 --company company.example --profile work --json
# Optional custom backend only:
poppykit backend --module /absolute/path/to/operator-backend.mjs --json
poppykit enroll --profile work --json
poppykit discovery --profile work --json
poppykit connect --profile work --json
poppykit auth-start --profile work --method device --scope orders:read --json
poppykit auth-continue OPERATION_ID --profile work --json
poppykit start --profile work --text 'A generic task' --send-operation task1 --json
poppykit retry task1 --profile work --json
poppykit sign-out --profile work --json
```

`discovery` reports issuer-selected `authMethods`, `scopes` and company
`scopeDescriptions`. `scopes` reports current authority and methods plus those
descriptions. Use the company's advertised scopes; `orders:read` above is only an
example. Prefer Direct when a registered callback is available.

On Windows an absolute module path can be `C:\secure\operator-backend.mjs`.
The backend is trusted operator code chosen locally; company or provider metadata
cannot select it. Configure an absolute path accessible only to trusted users.
Multiple profiles select independent providers/companies/installations; pass
`--profile` when more than one exists. Run `profile list` or `profile remove NAME`.
Existing profile configuration cannot be overwritten by setup; use a new profile.
Removal forgets configuration, and does not revoke remote credentials or erase a
separately configured backend. Export/retain needed records before manual reset.

## Secure storage and trusted input

This document describes version 0.5.0. Check the published version
and installed help before using its new native-storage or migration commands.

Linux uses the standard Secret Service through `/usr/bin/secret-tool` and the
user's unlocked persistent desktop keyring. See [Linux](linux.md) for distro
prerequisites, custody/concurrency, safe diagnostics and honest SSH/headless limits.

Windows defaults to current-user DPAPI through a hidden noninteractive PowerShell
helper, with material sent over internal stdin/stdout pipes. Immutable ciphertext
files have user-only ACLs, verified on every access. Missing user profile/DPAPI,
unsafe ACLs, reparse points or tampered files fail closed. DPAPI protects storage
at rest; arbitrary code running as the same Windows user can decrypt it.

CLI 0.5.0 automatically uses the default macOS Keychain to protect a random
wrapping key for the AES-256-GCM local ciphertext vault. The bundled universal
arm64/x86_64 Security.framework helper receives secrets through private pipes;
no compiler, Xcode, daemon, per-command passphrase or visitor-written adapter is
needed. Its deployment target is macOS 11.0; Node may require a newer OS.
Same-user programs are not isolated. Custody is scoped to the canonical absolute
vault path: moving ciphertext alone is not a backup or migration. Recovery needs
the matching OS vault and original path. Do not delete records or re-enroll as a
substitute for recovering local storage.

Locked/inaccessible Keychains fail closed. Ad-hoc signing preserves normal OS
access checks, so upgrading helper bytes can require one-time reauthorization.
Run `poppykit storage migrate` in a real terminal to permit the OS approval dialog,
or review access in Keychain Access, then retry the agent command. Routine commands
never open that dialog or weaken the Keychain ACL. This is separate from website
enrollment/company consent and from the attended vault passphrase.

To adopt existing `--unlock` storage on Windows, macOS or Linux:

```sh
poppykit storage migrate --json
```

Enter the existing passphrase once in its hidden real-terminal prompt. It is
never an argument, environment variable or JSON result. The old vault is verified
before native key custody changes; ciphertext, secret references, profiles,
enrollment, conversations and approvals are preserved. An interrupted migration
is safe to repeat; successful repeats need no passphrase. Wrong unlock leaves
custody unchanged. Then omit `--unlock`. Custom backends remain explicitly selected
and are not migrated. CLI 0.3.0 lacks this command and native Mac support.

For a provider offering the optional browser-enrollment service:

```sh
poppykit setup --provider https://identity.example/v1 --enrollment https://identity.example/enrollment --company company.example --json
poppykit enroll --json
# Open browserUrl yourself and approve the displayed installation.
poppykit enroll-status --json
poppykit connect --json
poppykit discovery --json
```

`enroll` and `auth-start` now wait for a browser decision by default. This is an
unreleased candidate feature; check installed help for `auth-wait` before using it.
The CLI opens the public HTTPS approval link when practical and writes progress,
the link and a safe resume handle to stderr. `--json` still emits one final JSON
object on stdout. Agents must keep their tool process/session running and consume
that result; no human “approved” message or second command is needed.

Waits last at most 300 seconds; `--wait-timeout SECONDS` accepts 1–300.
`--no-open` only displays the link. `--no-wait` preserves the low-level start
result for existing integrations. `auth-status`, `auth-continue`, `enroll-status`
and explicit cancellation commands remain available with their existing roles.
Each poll is a short request; the server never holds a human-length request open.
Rate-limit/device retry guidance is honored. SIGINT/SIGTERM stops the local wait
with exit 130 and retains the bound request. A timeout while waiting returns
pending plus resume metadata; lost one-time retrieval returns uncertain instead.
Definite enrollment expiry, denial, revocation or unauthorized rejection ends with
exit 3 and removes obsolete local enrollment material. Rate limiting remains
resumable. A lost/malformed response or a crash before received credentials are
staged remains uncertain (exit 6), including after process restart.
Received enrollment/callback material is saved encrypted before local completion.
Uncertain retrieval is never dispatched again: inspect and explicitly cancel the
saved request before starting a fresh authorization. Run `enroll` again for safely
saved enrollment or `auth-wait OP` for company
consent after interruption. `enroll-cancel`/`auth-cancel OP` explicitly cancel.
One local process at a time may consume each profile/connection approval; dead
owners can be recovered. Never delete state to bypass a live owner.

Enrollment and sufficient company grants are reused only under their saved
profile/installation/issuer/connection bindings. A scope upgrade still needs
consent; denial preserves earlier access. Browser completion means the server
saved a decision, and the waiting CLI still verifies and commits its result.
A closed agent or terminated process cannot be woken by this page: resume from
a new invocation. Lost one-time retrieval remains uncertain, never blindly replayed.

The CLI stages a private verifier before starting enrollment. Public browser links
and request IDs grant no authority. `enroll-status` redeems once and stages the
credential before binding the local profile. Repeating a successful retrieval
checks its saved local binding/secret and succeeds without redeeming again; it
does not attest remote authority or undo revocation. Poll pending retrievals at least two seconds apart.
`enroll-cancel` revokes a pending/delivered enrollment if delivery failed; an
uncertain/lost retrieval requires fresh enrollment. Company read/write consent is
a subsequent `auth-start` operation. Provider revocation stops signing; use company
revocation separately for issued grants. Credentials never belong in agent chat.

Safe provider errors distinguish clock/expiry (check automatic date/time),
enrollment rejection, rate limits, connectivity, malformed responses and server
unavailability. Fixed `error.nextAction` explains recovery without remote text.
Report the command, safe code and approximate UTC time. The CLI `requestId` is
local invocation correlation, not a Vercel request ID. Never share assertions,
credentials, passphrases or your local vault files with an error report.

Other unattended operation requires an explicit secure backend and a successful health
check; missing, locked, unavailable or malformed backends fail with exit **4**.
There is no plaintext fallback. Modules export `async open({purpose,unattended})`:

```js
// operator-backend.mjs: connect an existing secure vault/OS keychain/KMS adapter.
// operatorVault and operatorLogin are your own authenticated adapters.
export async function open() {
  const vault = await operatorVault.connect();
  return {
    async healthCheck() { await vault.requireUnlockedAndWritable(); },
    secrets: {
      stage: value => vault.createImmutableSecret(value), // random opaque reference
      read: ref => vault.readSecretOrNull(ref),
      remove: ref => vault.deleteSecret(ref),
    },
    enrollmentAuth: request => operatorLogin.enrollmentHeaders(request),
    trustedInput: operatorLogin.trustedInput,
    browserController: operatorLogin.agentControlledBrowser,
    close: () => vault.close(),
  };
}
```

`SecretStore` must be durable across invocations, isolate this installation,
return null for absent/foreign references (including SDK memory-token refs),
atomically create immutable secrets, and never log secret arguments/results.
Health checks must prove the backend is unlocked and usable before authority is
used. Failures are reduced to fixed diagnostics. Backends own secure authentication,
access policy, credential rotation and orphan-reference sweeping after crashes;
database/vault/network updates are separate transactions.

The exported `SecureBackend` type from `@poppykit/cli` defines the complete seam.
Optional `identity` is a local IdentitySigner whose public key is published by the
operator at the enrolled client ID's JWKS. `connect --anonymous` requires it and
fails clearly with `anonymous_unavailable` under provider-only custody. Optional
`transport` implements the SDK HttpTransport and must retain HTTPS, actual-address,
redirect and credential policies; default execution always uses the SDK transport.
It cannot be selected by remote metadata.

For **attended** headless/desktop use, omit `backend` and explicitly pass
`--unlock` on every command needing secrets:

```sh
poppykit enroll --unlock --json
poppykit connect --unlock --json
```

A real terminal prompts invisibly for a passphrase of at least 12 characters.
The bundled store derives per-record keys with scrypt and encrypts immutable
records with AES-256-GCM and fresh salts/nonces. An encrypted known-value check
detects a wrong unlock; its public reference is not a key. The passphrase/key is
never saved beside ciphertext, accepted as a flag/environment variable, or sent
to the provider. Redirected stdin/stdout cannot serve as the hidden input route.
Signal interruption restores terminal mode. Use a configured secure backend for
unattended work. CLI state defaults to `~/.poppykit` (`POPPYKIT_HOME` overrides it).
SQLite holds public configuration, scoped identifiers, transcript/retry payloads
and secret references; it is not a vault. Protect it as private local user data.

First-use vault markers publish atomically without replacing another initializer.
If an older interrupted installation left a broken `unlock-check`, stop and
retain the entire vault and state for operator-assisted recovery from a verified
backup. The CLI fails closed; it cannot infer which ciphertext owns that marker.
Do not remove the marker, reset keys or delete ciphertext to make initialization
succeed. Interrupted staging files can remain after process death; unrelated
ciphertext is preserved.

These promises are redaction, scoped authority and provider signing-key custody.
Encryption, permissions and helpers do not isolate authority from an unrestricted
program executing as the same OS user. Stronger isolation needs an independently
enforced boundary; the CLI does not claim one.

## Authentication and provider setup

`enroll` uses the operator's existing human authentication. The optional backend
`enrollmentAuth({url,installationId})` returns private request headers. Without
that hook, an attended terminal asks invisibly for the operator enrollment
credential. Operators must validate login, CSRF and allowed company policy. A
public provider URL or copied setup prompt is never enrollment authentication.

The provider reference lives at `@poppykit/client/provider` and optional
`@poppykit/client/provider/sqlite`; see the client package's `PROVIDER.md`. It is
vendor-neutral infrastructure, with operator-supplied HTTPS hosting, authentication,
signing/KMS, session ownership verification and result encryption key. The CLI
never receives identity private keys. It keeps enrollment credentials, Account
Tokens, DPoP keys and PKCE verifiers in its secure backend. No hosted token vault
or general identity platform is added.

Use `auth-start --method direct|device|mediated --scope S` and
`auth-status OP`, `auth-continue OP`, `auth-cancel OP`. Repeating sign-in for
broader scopes uses the shared SDK upgrade policy and preserves old access when
consent is declined. `scopes --scope S` reports granted/missing scopes and
advertised methods. Direct authorization URLs and Device verification links are
actionable when no opener is installed. The user opens them in their own browser.
Direct callbacks go to the operator's HTTPS provider; authenticated one-time
retrieval stays inside SDK code, bound to installation/enrollment, operation,
exact issuer and Session. Lost result delivery is uncertain, never automatically
exchanged again. No public inbound webhook is needed on the visitor's machine.

Mediated credentials come only from the configured `TrustedInput.collect` UI, or
the explicitly unlocked terminal's hidden input route. There is no password/code
flag and no request to paste a credential into a harness conversation. Device
`userCode` is the human-facing verification code; the private device code stays
inside the SDK backend. Neither authentication helper arguments nor JSON results
contain account tokens, private keys, Mediated values or callback codes.

`sign-out` revokes company authority through the SDK. `enrollment-revoke` disables
future provider signing/retrieval but cannot retract already-issued assertions,
Account Tokens, DPoP keys or Session Tokens. Revoke company authorization first,
or use the company's authenticated account settings afterward. Revocation never
silently reenrolls or signs in again.

## Conversations and integrations

`start --text TEXT --send-operation HANDLE` persists the original payload and
random message ID before dispatch. `send CONVERSATION --text TEXT` continues an
existing bound conversation. `retry HANDLE` reuses its exact original payload/ID
and generates fresh SDK authentication. Immutable profile UUID, enrollment,
installation, connection, full issuer, endpoint and resource prevent profile
changes from rerouting retries or existing conversations. `status HANDLE`
inspects metadata; `retry-remove HANDLE` explicitly deletes the CLI and SDK
retained retry payload. It cannot cancel remote accepted work. The CLI limits
retained retries and pending consumer deliveries to 1,000 each; explicitly remove
or acknowledge old records when full. There is no automatic transcript loss.

Failed sends return the saved `sendOperation`, including an automatically generated
handle. Typed company HTTP 5xx errors report `company_unavailable` and a safe
`error.httpStatus`; remote error bodies are never copied into CLI diagnostics.
The company may be paused. Ask its operator to check availability. Delivery remains
unconfirmed: preserve the handle and use `retry HANDLE` when ready, rather than
creating another message or repeating enrollment. Read current shared state before
preparing a new versioned update; a failed send does not prove that no brief exists.

`read CONVERSATION` reads one page. `watch CONVERSATION` returns at most 100
events or 30 seconds and returns a cursor; pass `--cursor` to resume. For durable
consumption use `--consumer NAME`, process the returned batch, then `ack DELIVERY`
with the top-level JSON `delivery` token (outside `result`).
Acknowledgement uses the SDK's compare-and-set checkpoint and stale acknowledgements
cannot rewind it. Read/watch never implicitly acknowledge a batch. SIGINT/SIGTERM
cancel the invocation; another invocation's live auth exchange remains intact.
Cancellation cannot undo a remote exchange already sent. Inspect auth operation
status after interruption; lost remote results remain uncertain rather than
silently exchanging a code again. Custom trusted-input adapters own cancellation
of their UI and must return promptly on application shutdown.
Use `handoff CONVERSATION` and `close CONVERSATION` for lifecycle actions.

`api-target --api URL [--destination URL]` resolves the SDK verified target.
`api-request --api URL --destination URL [--method GET|HEAD]` uses SDK authorization
and returns response status/target metadata; sensitive headers/body stay private.
`browser-join --return-to URL` requires the trusted backend's `agent-controlled`
browser controller and sends the SDK form directly to it. It is separate from
user consent. `feedback --task TASK --description TEXT` sends one SDK report and
expects empty 202; it does not automatically retry an uncertain acceptance.

## Output and diagnostics

`--json` emits one JSON object with `version:1`, command, requestId, status and
result/error. Human output formats the same safe result. Watch returns a bounded
batch, not an unbounded logging stream. Fixed errors redact raw provider, company,
backend and OS diagnostics. Company conversation content remains untrusted data;
applications must not promote it to instructions or put their own secrets in it.
Opaque data and extension fields roundtrip exactly, including keys named
`authorization`, `credential` and `secret`. Auth state is projected separately.
See [typed errors and scope upgrades](../API.md) for machine-readable recovery.

| Exit | Meaning |
| --- | --- |
| 0 | Completed or explicitly pending/resumable operation |
| 1 | Runtime, transport or remote failure |
| 2 | Invalid command/configuration input |
| 3 | Authentication/authorization needed, denied or failed |
| 4 | Secure storage or trusted user/browser input unavailable |
| 5 | Immutable destination/state binding conflict |
| 6 | Uncertain exchange/result delivery; inspect before further action |
| 130 | User cancellation |

`diagnostics` is available without credentials and reports Node/platform, state
path, execution model and configured backend presence. It does not probe or dump
credentials. An unsupported Node runtime fails before optional SQLite loads.

A public setup prompt contains only these four fields (use an actual published
or locally supplied candidate version):

```text
Package: @poppykit/cli@0.5.0 (verify publication before registry install)
Provider: https://identity.example/v1
Company: company.example
Task: Ask about the available services.
```

The packaged workflow checks real installed shims and lifecycle on Windows, macOS
and Linux. Its generic HTTP tunnel does not certify production TLS, a native
keyring, physical terminal, KMS or browser engine. Every new artifact requires
its own [release verification](../RELEASING.md); old results do not certify new bytes.

## Unreleased draft 0.3 cutover

Outgoing messages use `author.type`; `--human` marks exact human text and otherwise
the author is `agent`. Retries reuse the SDK's stored request, ID and target.
This is a breaking change without backward compatibility. Reset old conversation,
retry, delivery and checkpoint data at cutover while preserving profiles and
secure configuration. `legacy_message_uncertain` exits 6 without dispatch;
reconcile it before discarding its handle, and never create a replacement message
to bypass uncertainty.

### Draft 0.3 integration checkpoint

`feedback --task TASK --description TEXT` returns `{accepted:true}` for empty
202, or also `alternative` for a validated 200 response. Instructions/references are
company data, not consent. Unknown reference types and unlisted API references are
omitted; malformed known references fail. Nothing is executed automatically.
`excluded-tasks` returns `{tasks:[...]}` using the same reference validation and
public HTTP metadata cache. `discovery` exposes its URL and conservative scope hints.
The caller owns the SHOULD-level early task check; the CLI has no task planner.

Trusted browser backends now implement `loadJoinForm`, `postForm` and `navigate`:
read the code from the exact endpoint in their own isolated browser, outside model
context; preserve its cookie; submit the SDK's code/proof without redirect replay.
The provider no longer signs browser assertions. Bearer-only MCP uses Token Exchange;
DPoP-capable MCP retains normal grants. These candidates remain unreleased pending F.
