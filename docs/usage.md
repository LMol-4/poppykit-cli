# CLI configuration and operations

One npm CLI for Windows, macOS and Linux, including attended and unattended
headless use. It runs the client SDK directly. Install Node **24.12.0 or newer**;
npm packages do not bundle Node. No PowerShell, second terminal, desktop keyring,
browser opener or manually managed helper/daemon is required.

The packages are currently unpublished version `0.0.0`. For a candidate, install
the unchanged tested CLI and client tarballs together:

```sh
npm install ./poppykit-client-0.0.0.tgz ./poppykit-cli-0.0.0.tgz
npx poppykit --help
```

After publication the CLI's exact SDK dependency is installed by npm. Development
candidate installation also supplies the client tarball explicitly, alongside the
existing pinned TypeScript 5.9.3, @types/node 24.10.0 and undici-types 7.16.0.
The old pnpm lock described the superseded dependency-free pipe client; it is
removed rather than pretending to resolve an unpublished package from npm.

```sh
poppykit setup --provider https://identity.example/v1 --company company.example --profile work --json
poppykit backend --module /absolute/path/to/operator-backend.mjs --json
poppykit enroll --profile work --json
poppykit connect --profile work --json
poppykit auth-start --profile work --method device --scope poppy:read --json
poppykit auth-continue OPERATION_ID --profile work --json
poppykit start --profile work --text 'A generic task' --send-operation task1 --json
poppykit retry task1 --profile work --json
poppykit sign-out --profile work --json
```

On Windows an absolute module path can be `C:\secure\operator-backend.mjs`.
The backend is trusted operator code chosen locally; company or provider metadata
cannot select it. Configure an absolute path accessible only to trusted users.
Multiple profiles select independent providers/companies/installations; pass
`--profile` when more than one exists. Run `profile list` or `profile remove NAME`.
Existing profile configuration cannot be overwritten by setup; use a new profile.
Removal forgets configuration, and does not revoke remote credentials or erase a
separately configured backend. Export/retain needed records before manual reset.

## Secure storage and trusted input

Unattended operation requires an explicit secure backend and a successful health
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

`read CONVERSATION` reads one page. `watch CONVERSATION` returns at most 100
events or 30 seconds and returns a cursor; pass `--cursor` to resume. For durable
consumption use `--consumer NAME`, process the returned batch, then `ack DELIVERY`.
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
Package: @poppykit/cli@0.0.0
Provider: https://identity.example/v1
Company: company.example
Task: Ask about the available services.
```

The packaged CI workflow installs actual CLI/client tarballs into clean projects
on Windows, macOS and Linux. Local Windows evidence includes durable encrypted
subprocess auth/retry tests; its generic fixture explicitly replaces networking
with a trusted HTTP tunnel, so it does not prove TLS or native keyring behavior.
J6 recorded actual Windows/macOS/Linux results for its own immutable artifacts.
Changed J7 candidates require fresh checks; no prior result certifies changed bytes.
No package publication, service deployment or demo application is included.
