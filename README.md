# PoppyKit CLI

Terminal client for [Personal Agent Protocol draft 0.2](https://personalagentprotocol.org/docs/0.2/spec),
built on the client SDK. Discover companies, authenticate and exchange conversations
or use verified integration hooks. [MIT](LICENSE).

## Install

Version 0.3.0 is a release candidate until its publishing workflow completes.

Requires Node **24.12.0+** and npm on Windows, macOS or Linux. CI tests Node 24.12.0;
later majors are not separately certified. Windows default custody uses its bundled
hidden PowerShell/DPAPI helper. No daemon or automatic browser opener is required. npm installs the exact client dependency;
there is no server SDK dependency and Node is not bundled.

```sh
npm install --global @poppykit/cli@0.3.0
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

Windows uses current-user DPAPI by default with user-only ACL checks. Browser
enrollment needs no visitor-written backend. Other unattended environments use a
locally selected secure-backend module. Attended commands can explicitly use
`--unlock` in a real terminal. There is no plaintext fallback.
SQLite state is not a vault, and arbitrary same-user execution is not isolated.
Inspect uncertain outcomes before retrying; cancellation cannot undo a sent action.

## Guides

[Operations](docs/usage.md) covers profiles, secret custody, sign-in, durable retry,
conversations, exit codes and API/browser/feedback commands. [API.md](API.md) maps
backend exports/types. See [contributing](CONTRIBUTING.md), [security](SECURITY.md),
[changelog](CHANGELOG.md) and the [release runbook](RELEASING.md).
