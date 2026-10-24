# Native Linux credential storage

The 0.3.1 source candidate adds a built-in Linux backend. Publication and a test of
the integrated browser approval flow are separate release/integration steps.

Use **Node 24 >=24.22.1 (24.x only)** with its built-in `node:sqlite` enabled, npm, and a normal
logged-in desktop user session. Install the distribution package
providing `/usr/bin/secret-tool`, plus a running Secret Service provider
(for example GNOME Keyring) on that user's session D-Bus. The default persistent
collection must exist, be unlocked and permit reads/writes. On Ubuntu/Debian,
`libsecret-tools` is the CLI prerequisite; a minimal desktop may also need
`gnome-keyring` and the session's D-Bus/login integration. The CLI does not install,
start, configure or unlock a desktop keyring for you. A KWallet setup must actually
provide the Secret Service interface; installing KWallet alone is not evidence.
Do not use `sudo poppykit`: it changes the user, home and keyring context.

The executable is available in mainstream distro repositories, but its presence
in default installations varies with the distribution, desktop and selected
packages. A desktop keyring does not establish that `secret-tool` is installed.
Check with `command -v secret-tool`. To add the command when missing:

| Distribution | Package installation |
| --- | --- |
| Ubuntu/Debian | `sudo apt install libsecret-tools` |
| Fedora | `sudo dnf install libsecret` |
| Arch | `sudo pacman -S libsecret` |

These commands install the client tool, not an assurance of an unlocked keyring.
Package contents checked 2026-10-24:
[Ubuntu](https://packages.ubuntu.com/noble/libsecret-tools),
[Fedora](https://packages.fedoraproject.org/pkgs/libsecret/libsecret/fedora-44.html),
[Arch](https://archlinux.org/packages/core/x86_64/libsecret/files/).

Install the CLI normally with npm, then follow [usage](usage.md). No user-written
JavaScript backend, native Node addon, compiler, daemon or CLI unlock password is
needed. Windows DPAPI and macOS Keychain selection are unchanged. Linux browser
launching also needs the desktop opener used by the integrated approval flow;
when it cannot open a browser, use the safe link printed by that command. Opening
a link from SSH does not establish a local desktop/keyring session on the server.

The backend keeps the vault wrapping key in the default Secret Service collection;
the local vault remains AES-256-GCM ciphertext. It invokes an absolute system
executable without a shell and passes key material only through private pipes,
never argv, environment variables, JSON diagnostics or logs. Item attributes bind
the canonical vault path's hash and a random reference. They are identifiers, not
secrets. The user-owned vault directory must have mode `0700`; the local
`native-unlock` reference must be a regular user-owned `0600` file, not a symlink.
An existing group/world-accessible directory is refused rather than chmodded.
The vault filesystem must support private POSIX permissions and hard links.
Changing the path or copying ciphertext without the original keyring is not a
backup. Protect the CLI home and its SQLite state as private user data too.

Each initializer stages and verifies its own randomly identified keyring item,
then atomically publishes a complete reference using the existing native-store
hard-link mechanism. Competing processes use the winning key and remove their
unused candidate. A crash before publication can leave an unreferenced keyring
item; it cannot replace the published key. Keep the referenced item. Inspect
unreferenced `org.poppykit.cli` items in your keyring manager before manual cleanup;
the CLI does not sweep or delete existing user data.

## Recovery and diagnostics

`poppykit diagnostics --json` remains offline: its Linux prerequisites report
whether the fixed executable is accessible and whether a session-bus address is
configured. `not-probed` is deliberate; diagnostics do not connect to D-Bus,
initialize storage or trigger a prompt. A configured bus address does not prove a
live bus, and an absent address does not rule out the platform's bus discovery.
Commands needing custody perform a real encrypted-store health check.

`linux_secret_tool_missing` means the system helper could not be launched because
it is absent. `linux_secret_service_unavailable` covers missing/locked keyrings,
missing or disconnected session buses, denied access, malformed custody records
and the bounded 15-second helper timeout. `secret-tool` does not give a stable
typed distinction between those cases; the CLI never parses localized stderr or
forwards its potentially private text. A failed lookup of a published reference
never means “empty vault” and never creates a replacement key. Unlock or repair
the original keyring/session in your desktop, then retry. Secret Service can show
its own OS prompt; an agent/non-TTY invocation may fail or time out instead.

To adopt an existing attended vault, run `poppykit storage migrate --json` in your
own real terminal in the same CLI home. It verifies the old hidden passphrase,
then protects that existing wrapping key with Secret Service. It preserves
ciphertext, references, profiles and approvals; a wrong passphrase does not change
custody, and an interrupted migration can be retried. Subsequent commands omit
`--unlock`. This does not persist the desktop keyring's unlock password or put a
key beside the ciphertext. Custom backend modules retain explicit selection and
are not migrated. Keep secrets and passphrases out of chat.

## Headless, SSH and CI

An SSH session can use this backend only when it legitimately shares that same
user's live session bus and already unlocked persistent collection. A TTY, X11
forwarding, `DISPLAY` or an arbitrary copied bus address alone is insufficient.
The CLI never creates an unprotected keyring, saves its unlock password or falls
back to plaintext or unattended passphrase entry. General unattended headless
support is not claimed. For attended use, the existing explicit `--unlock` route
still requires a real terminal on every invocation. Operator-owned secure-backend
modules remain an optional existing extension, not a desktop Linux requirement.

The native check uses real libsecret/GNOME Keyring under an isolated D-Bus, HOME
and runtime directory, with a random test-only unlock secret passed by pipe. It
does not touch the runner's login keyring. From the CLI checkout, after the usual
build/test-harness and clean candidate installation:

```sh
node scripts/linux-native-session.mjs '/absolute/clean install ü/node_modules/@poppykit/cli'
node scripts/packaged-check.mjs '/absolute/clean install ü'
```

Test prerequisites additionally include `dbus`, `gnome-keyring` and
`libglib2.0-bin` (`gdbus`). The smoke checks separate processes, non-TTY operation,
Unicode/space paths, concurrent initialization, ciphertext-preserving migration,
wrong unlock, unsafe ownership permissions, missing bus and locked keyring.
This proves the tested Linux environment's native custody; it does not certify
every distro, ARM build, desktop unlock UI, SSH setup or browser/agent integration.

Mechanism evidence checked 2026-10-24: the
[upstream libsecret tool implementation](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c)
defines private-stdin storage, lookup's ambiguous failure status and default
collection selection; the
[Secret Service unlocking specification](https://specifications.freedesktop.org/secret-service/latest/unlocking.html)
defines service-mediated unlocking. The implementation's local reference handles
that ambiguous lookup status without treating an unavailable store as empty.
