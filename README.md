# PoppyKit cli

Command-line interface for personal-agent runtimes. The current implementation
talks to a configured host; the planned replacement calls the Poppy client SDK directly.

An optional adapter for runtimes that execute commands. Products integrating the
client SDK directly do not need this CLI. Protocol logic belongs in the client
SDK; company applications and demo workflows remain outside the CLI.

The first CLI targets a configured local agent host through a versioned protected
command channel. The host implementation is supplied separately.
Profiles select hosts and connections; credentials stay in the host. Pending work,
uncertain exchanges and incomplete remote revocation have explicit machine results.
This describes current functionality. The reviewed programme includes a
cross-platform direct-SDK CLI, hosted identity enrollment, all three sign-in
methods, and packaged Windows/macOS/Linux verification. Those capabilities are
not yet implemented. No demo application is part of that programme.

Status: CLI implemented against the host contract (`docs/host-contract.md`); not published.

Saved sends bind their original host pipe and connection. Retries reject changed
destinations before sending; old unbound records fail closed. See
[the host contract](docs/host-contract.md) for inspect/reset guidance. Retained send
files contain message bodies, not only public configuration.

Node 24.12.0 or later is required. Minimal CI runs build, type and unit checks on
Windows because the current host channel uses Windows pipes. J5 owns the direct-SDK
rewrite and packaged Windows/macOS/Linux evidence; those checks are not yet supplied.

The planned security promise is secret redaction, scoped authority, and provider
signing-key custody. A helper or encrypted local store does not isolate authority
from an unrestricted same-user harness. Unattended headless use will require an
explicit secure backend, with clear failure instead of plaintext fallback.

## Usage

Run `poppykit help` or `poppykit --help` for full command syntax, options and
retry guidance. These exact top-level commands print plain text, exit 0, and
work offline without reading or changing profiles/state. All operational commands
retain JSON output. Command-specific help and the `discover` alias are not supported;
use `discovery <domain>`.

`poppykit [profile add|list|remove] | <command> [--profile P] [--connection C]`. State lives in
`%LOCALAPPDATA%\poppykit-cli` (override: `POPPYKIT_HOME`): `profiles.json` (public config) and
`sends/<handle>.json` (persisted send handles, written before the host is contacted).

Commands: `discovery <domain>`, `connect <domain>`, `connections`, `login --scope S [--connection C | --domain D [--replace C]]`,
`status <op> [--login]`, `cancel <login-op>`, `logout [--connection C]`, `start|send <conv>|direct <conv>` with
`--text/--data/--context/--human/--message-id/--send-operation/--wait`, `read <conv> [--cursor C] [--wait N] [--consumer NAME]`, `ack <conv> --consumer NAME --cursor C`,
`handoff <conv>`, `close <conv>`. Inspect uncertain sends with `status <handle>`;
retry using the original `start`, `send` or `direct` command with only
`--send-operation <handle>` and the original profile (optionally `--wait`): saved IDs/content/target are reused.
One JSON result on stdout; exit 0 succeeded/accepted/pending, 1 failed (including uncertain), 2 invalid invocation.

The channel is a PowerShell 7 helper (`helpers/pipe-client.ps1`, mirrors the client rules in the demo's
protected-channel doc): Identification impersonation level, server end must be owned by the current user.
Windows with `pwsh` on PATH only.

Targets the current [Personal Agent Protocol draft 0.2 specification](https://personalagentprotocol.org/docs/0.2/spec)
and [guides](https://personalagentprotocol.org/docs/0.2/guides).

The October 19 source pin and Windows host design are historical baselines.
Current online draft 0.2 sources govern protocol behavior. Existing usage above
remains Windows-only until the planned implementation and platform checks pass.

This is an independent implementation. Protocol conformance has not yet been tested.

Creating this repository does not reserve a name on npm, PyPI, or crates.io.


## Package names

- npm: @poppykit/cli
- Future PyPI distribution: poppykit-cli (Python import: poppykit_cli)
- Future crates.io package: poppykit-cli (Rust library name: poppykit_cli, if applicable)

These are intended names, not reserved registry packages. Python and Rust implementations are not yet present.

