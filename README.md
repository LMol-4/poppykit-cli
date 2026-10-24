# PoppyKit CLI

Terminal client for [Personal Agent Protocol draft 0.2](https://personalagentprotocol.org/docs/0.2/spec),
built on the client SDK. Discover companies, authenticate and exchange conversations
or use verified integration hooks. [MIT](LICENSE).

## Install

Version 0.3.1 is an unreleased candidate until its publishing workflow completes.
Native macOS custody and storage migration below require 0.3.1; they are absent in 0.3.0.
The browser-wait changes are also unreleased: check installed help for `auth-wait`.
`enroll` and `auth-start` wait for browser decisions and return to a running calling
agent automatically. See [bounded waits and recovery](docs/usage.md); a terminated
agent needs a new invocation to resume its saved request.

Requires Node **24.12.0+** and npm on Windows, macOS or Linux. CI tests Node 24.12.0;
later majors are not separately certified. Windows default custody uses its bundled
hidden PowerShell/DPAPI helper. macOS uses Keychain through a bundled universal
native helper; users do not need a compiler or Xcode installation. Linux uses
Secret Service through the system `secret-tool` command and an unlocked
desktop keyring/session D-Bus; see [Linux prerequisites and recovery](docs/linux.md).
No daemon or
automatic browser opener is required. npm installs the exact client dependency;
there is no server SDK dependency and Node is not bundled.

```sh
npm install --global @poppykit/cli@0.3.1
```

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

## Guides

[Operations](docs/usage.md) covers profiles, secret custody, sign-in, durable retry,
conversations, exit codes and API/browser/feedback commands. [API.md](API.md) maps
backend exports/types. See [contributing](CONTRIBUTING.md), [security](SECURITY.md),
[changelog](CHANGELOG.md) and the [release runbook](RELEASING.md).
