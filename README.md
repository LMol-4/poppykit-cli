# PoppyKit CLI

A terminal harness for Personal Agent Protocol draft 0.2, built on the client SDK.
Use it to discover/connect to companies, enroll with an operator's hosted identity
provider, sign in, exchange conversations and call verified integration hooks.

## Installation

Requires Node **24.12.0 or later** and npm on Windows, macOS or Linux, including
headless Linux. No PowerShell, manual daemon, second terminal or browser opener
is required. CI certifies Node 24.12.0; later majors are not separately certified.
The packages are **private and unpublished, version 0.0.0**. Install verified
candidate tarballs together so npm resolves the exact client dependency:

```sh
npm install ./poppykit-client-0.0.0.tgz ./poppykit-cli-0.0.0.tgz
npx --no-install poppykit --help
```

After public release npm will install the exact client dependency automatically.
There is no server SDK dependency and npm does not bundle Node.

## Quickstart

Run the first two commands without credentials. Replace example operator/company
URLs with actual configured services before enrollment:

```sh
npx --no-install poppykit diagnostics --json
npx --no-install poppykit setup --provider https://identity.example/v1 --company company.example --profile work --json
npx --no-install poppykit enroll --profile work --unlock --json
npx --no-install poppykit connect --profile work --unlock --json
npx --no-install poppykit auth-start --profile work --unlock --method device --scope poppy:read --json
```

The attended route requires a real terminal and a hidden passphrase of at least
12 characters. Enrollment also needs the operator's existing authentication.
Open the verified Device link in your own browser and resume with
`auth-continue OPERATION_ID`. Direct and Mediated are also supported when
advertised by the company. These example URLs are placeholders, not hosted services.

## Configuration and authentication

[Configuration and operations](docs/usage.md) covers the hosted provider, all
three sign-in methods, scope upgrades/partial consent, multiple profiles, explicit
revocation and trusted browser input. A public setup prompt contains only package
version, provider URL, company domain and task; it contains no secrets. The operator
hosts the provider and supplies authenticated enrollment and signing-key custody.

Attended use explicitly unlocks encrypted storage each invocation. Unattended use
requires a trusted locally selected secure-backend module and successful health
check; there is no plaintext fallback. The [backend contract](API.md) describes
`SecureBackend` and its imported SDK types. State defaults to `~/.poppykit`
(`POPPYKIT_HOME` overrides it). SQLite stores configuration/retry data and secret
references, not vault encryption. Same-user arbitrary execution is not isolated.

## Examples and common operations

Use `start --text TEXT --send-operation HANDLE`, `send CONVERSATION --text TEXT`,
`read/watch CONVERSATION` and explicit `ack DELIVERY` for durable consumption.
`retry HANDLE` preserves the original payload/message ID and immutable destination;
`status HANDLE` inspects it and `retry-remove HANDLE` removes retained local data.
`sign-out` revokes company authority; `enrollment-revoke` separately disables
new provider assertions/results and cannot retract company-issued authority.

API requests and browser joining use trusted SDK adapters. They do not build a
universal executor or browser driver. Feedback sends a single report. Full command
examples, safe output fields and the exit-code table are in [usage](docs/usage.md).
Run `npx --no-install poppykit --help` for the command reference.

## Errors, cancellation, retries and limits

`--json` emits a version-1 object with command/request ID/status and safe result
or fixed error code. Exit 0 includes pending/resumable states; inspect status.
SIGINT/SIGTERM cancel work but cannot undo a sent remote exchange. Lost remote
results remain uncertain and must be inspected, never silently replayed.
Watch is bounded to 100 events/30 seconds. Retry/delivery retention is bounded to
1,000 each and requires explicit removal/acknowledgement. Feedback is not retried.
See [troubleshooting and exit codes](docs/usage.md#output-and-diagnostics).

## Reference and support

[API.md](API.md) links adapter types and command configuration. Packaged generic
fixtures verify installed shims, lifecycle, headless failures, isolation and
redaction; production vault/browser/provider hosting require operator checks.
See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[CHANGELOG.md](CHANGELOG.md) and [RELEASING.md](RELEASING.md). No public license grant
has been selected; registry and licensing decisions remain owner prerequisites.
