# Changelog

## Unreleased — remediation job 3

Declare the directly imported jose harness dependency. Retry ordinary safe reads
after transient failure or new permission without rebinding saved business approvals.
Add durable caller-chosen `api-request --new-action ID`, fresh per-action consent,
summary-only active listing and `operation-retire HANDLE` for terminal work.
Retirement frees the 1,000-active-record ceiling while keeping indexed replay fences;
unresolved work remains retained. Existing records migrate additively on open.
Stop old writers and preserve both local databases on backup/restore. Terminal SDK
snapshots are not purged. Publication requires the repaired SDK and normal release gates.

## 0.6.2

Pin client 0.6.1 and verify against server 0.5.1, including the SDK fix for lost PostgreSQL connections. Trusted operation review and native credential custody are unchanged.

## 0.6.1

Trusted business review now receives the exact operation ID/revision and context. A locally configured `business-backend --module` supplies consent/reconciliation while retaining the existing native credential backend. Module failures fail closed with private diagnostics.

## 0.6.0 — current-spec migration

Use the migrated client 0.6.0 with independent delegated Sessions/OAuth, issuerless Companies, code-only browser joining and current feedback. Add per-operation trusted console/backend consent, exact request/revision binding, operation-required exit 7, durable decline/resume/retry/reconciliation and authority-change fences. Preserve opaque business JSON and native credential custody. Provider enrollment and OAuth consent never approve business work. Local candidate; publication is established only by the final release receipt.

## 0.5.0 — 2026-10-28

Historical snapshot of draft 0.3, superseded by the current migration. Used client 0.5.0. Bind Direct sign-in custody to the Session Key, emit author messages and expose feedback alternatives/excluded tasks. Restart incompatible pending sign-ins; preserve uncertain retries until reconciliation/reset.

Local migration candidate only. Publication and deployment require separate approval.

## 0.4.1

Support Node 24.21.0 and later within Node 24 under the owner-accepted runtime policy.
Build, verification and publication tooling read .node-version.

## 0.4.0

- Require patched Node 24 >=24.22.1 within 24.x; reject unsupported majors.
- Use trusted Windows approval execution and atomic encrypted-vault initialization.
- Preserve opaque protocol JSON, expose typed scope/retry details and retire
  terminal approval secrets while keeping uncertain redemption fenced.
- Distinguish definite enrollment rejection from lost/staging outcomes, and fix
  source/release subprocess paths containing spaces or Unicode.

- Browser enrollment and direct company consent wait for a committed decision,
  return automatically to the calling agent and retain safe interrupted recovery.
- Built-in Linux Secret Service wrapping-key custody using libsecret's `secret-tool`,
  atomic references across processes, existing-vault migration and safe failures.
- Isolated real Linux keyring/package CI alongside Windows/macOS native checks;
  [desktop prerequisites and headless limits](docs/linux.md) are explicit.

Add automatic macOS Keychain custody through a bundled universal native helper,
and explicit single-unlock adoption of existing attended storage on Mac/Windows.
Migration preserves ciphertext/references and recovers interrupted publication.
Repeated successful enrollment retrieval now succeeds locally without redeeming
again. Pin client 0.4.0 for corrected callbacks, bounded assertion clock tolerance
and safe actionable provider diagnostics. Windows DPAPI files receive explicit owner-only ACLs.
Company HTTP 5xx failures now expose a fixed availability diagnostic and retain
the saved send handle, with guidance to retry the same message after recovery.
Opaque protocol data stays inside `result`; CLI delivery and retry controls are
top-level fields. Callers must use the documented envelope rather than reading
control-shaped keys from protocol results.

## 0.3.0 (release candidate)

Add browser enrollment start/status/cancel with private verifier custody, atomic
profile binding and failed-delivery revocation. Add default Windows current-user
DPAPI custody with verified user-only ACLs and fixed secret-free diagnostics.
Retain custom backends, attended storage and all SDK authentication methods.

## 0.2.0 (release candidate)

Await asynchronous provider callbacks and pin client 0.2.0.

## 0.1.1

Documentation refresh: registry installation, runnable quickstarts, focused guides
and the tagged GitHub/OIDC release runbook. No runtime API, storage format or
third-party dependency change. Client dependency is exactly 0.1.1; SDK candidate pins match that release.

## 0.1.0

Initial MIT development release, published manually. Discovery, safe HTTPS, all
three sign-in methods, targeted durable storage and recovery, conversations and
API/browser/feedback hooks. The CLI uses the client SDK with trusted secure-backend
adapters. J8 established strict typed tests and exact installed-artifact checks.

Version 0.x may still change APIs/storage; future changes must explain compatibility,
migration/reset and security implications. No stable 1.0 or external-host certification
is promised. Older private 0.0.0 candidates retain their own historical evidence.
