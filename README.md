# PoppyKit CLI

Terminal client for [Personal Agent Protocol draft 0.3](https://personalagentprotocol.org/docs/0.3/spec).
Discover companies, authenticate and exchange conversations. [MIT](LICENSE).

## Install

```sh
npm install --global @poppykit/cli@0.5.0
```

Linux requires `secret-tool` and an unlocked desktop keyring; see [Linux setup](docs/linux.md).

## Start offline

These commands need no credentials or configured provider:

```sh
poppykit --help
poppykit diagnostics --json
```

Then follow [setup and authentication](docs/usage.md) with your actual operator
provider URL and company domain. Enrollment requires operator authentication;
a public URL or copied prompt is not authentication. Advertised Direct, Device
and Mediated methods use trusted human interaction.

Windows uses current-user DPAPI with user-only ACL checks. macOS keeps its local
encrypted vault's wrapping key in Keychain; Linux uses Secret Service. Routine commands need no CLI passphrase
while the OS vault is unlocked and access is permitted. After a helper upgrade,
one-time OS access approval may be needed: run `poppykit storage migrate` in your
own terminal. That command also adopts existing attended storage with one private
unlock, preserving ciphertext and profiles. Browser enrollment needs no
visitor-written backend on supported desktops. Other unattended environments use a
locally selected secure-backend module. Attended commands can explicitly use
`--unlock` in a real terminal. There is no plaintext fallback.
SQLite state is not a vault, and arbitrary same-user execution is not isolated.
Inspect uncertain outcomes before retrying; cancellation cannot undo a sent action.

JSON scope failures include `error.requiredScopes`. Request those scopes through
`auth-start`, obtain explicit human consent, then `retry` the saved `sendOperation`
in its original conversation. Denial preserves earlier grants. `read` and `watch`
preserve structured company data and extension fields exactly; credential-like
business field names are valid data. Auth results expose public connection and
operation fields; raw provider/OS errors remain private.

## Guides

[Operations](docs/usage.md) covers profiles, secret custody, sign-in, durable retry,
conversations, exit codes and API/browser/feedback commands. [API.md](API.md) maps
backend exports/types. See [contributing](CONTRIBUTING.md), [security](SECURITY.md),
[changelog](CHANGELOG.md) and the [release runbook](RELEASING.md).
