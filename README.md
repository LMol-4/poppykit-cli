# PoppyKit cli

Command-line interface for personal-agent runtimes, built on the Poppy client SDK.

An optional adapter for runtimes that execute commands, including the Codex demo.
Products integrating the client SDK directly do not need this CLI. Protocol logic
belongs in the client SDK; local demo startup and company-agent setup belong in
[poppykit-demo](https://github.com/LMol-4/poppykit-demo).

The first CLI targets a configured local agent host through a versioned protected
command channel. The demo companion is one implementation of that contract.
Profiles select hosts and connections; credentials stay in the host. Pending work,
uncertain exchanges and incomplete remote revocation have explicit machine results.
Remote host transports and hosted identity provisioning are outside the first scope.

Status: CLI implemented against the host contract (`docs/host-contract.md`); not published.

## Usage

Run `poppykit help` or `poppykit --help` for full command syntax, options and
retry guidance. These exact top-level commands print plain text, exit 0, and
work offline without reading or changing profiles/state. All operational commands
retain JSON output. Command-specific help and the `discover` alias are not supported;
use `discovery <domain>`.

`poppykit [profile add|list|remove] | <command> [--profile P] [--connection C]`. State lives in
`%LOCALAPPDATA%poppykit-cli` (override: `POPPYKIT_HOME`): `profiles.json` (public config) and
`sends/<handle>.json` (persisted send handles, written before the host is contacted).

Commands: `discovery <domain>`, `connect <domain>`, `connections`, `login --scope S [--domain D [--replace C]]`,
`status <op> [--login]`, `cancel <login-op>`, `logout`, `start|send <conv>|direct <conv>` with
`--text/--data/--context/--human/--message-id/--send-operation/--wait`, `read <conv>`, `ack <conv>`,
`handoff <conv>`, `close <conv>`. Inspect uncertain sends with `status <handle>`;
retry using the original `start`, `send` or `direct` command with only
`--send-operation <handle>` and the original profile (optionally `--wait`): saved IDs/content/target are reused.
One JSON result on stdout; exit 0 succeeded/accepted/pending, 1 failed (including uncertain), 2 invalid invocation.

The channel is a PowerShell 7 helper (`helpers/pipe-client.ps1`, mirrors the client rules in the demo's
protected-channel doc): Identification impersonation level, server end must be owned by the current user.
Windows with `pwsh` on PATH only.

Targets the Personal Agent Protocol (Poppy): https://personalagentprotocol.org/docs/spec

Current design target (reviewed 2026-10-19): draft **0.2, in progress**, pinned to
`30c476455c20c23c13b050c74c47d9b3269413c7`. The CLI must report unsupported pre-1.0
versions explicitly and preserve user sign-out intent across commands: an
authorization event or sign_in_required error must not silently reconnect a user
who signed out or disconnected. If Device Sign-In is added, validate links before
display and show the company name/domain.

This is an independent implementation. Protocol conformance has not yet been tested.

Creating this repository does not reserve a name on npm, PyPI, or crates.io.


## Package names

- npm: @poppykit/cli
- Future PyPI distribution: poppykit-cli (Python import: poppykit_cli)
- Future crates.io package: poppykit-cli (Rust library name: poppykit_cli, if applicable)

These are intended names, not reserved registry packages. Python and Rust implementations are not yet present.

