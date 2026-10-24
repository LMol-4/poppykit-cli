# Changelog

## 0.3.1 (unreleased candidate)

Add automatic macOS Keychain custody through a bundled universal native helper,
and explicit single-unlock adoption of existing attended storage on Mac/Windows.
Migration preserves ciphertext/references and recovers interrupted publication.
Repeated successful enrollment retrieval now succeeds locally without redeeming
again. Pin client 0.3.1 for bounded assertion clock tolerance and safe actionable
provider diagnostics. Windows DPAPI files receive explicit owner-only ACLs.

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
