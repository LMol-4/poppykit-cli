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

Status: initial project scaffold. No SDK or CLI implementation is published yet.

Targets the Personal Agent Protocol (Poppy): https://personalagentprotocol.org/docs/spec

Current design target (reviewed 2026-10-19): draft **0.2, in progress**, pinned to
`30c476455c20c23c13b050c74c47d9b3269413c7`. The CLI must report unsupported pre-1.0
versions explicitly and preserve user sign-out intent across commands: an
authorization event or sign_in_required error must not silently reconnect a user
who signed out or disconnected. If Device Sign-In is added, validate links before
display and show the company name/domain. No commands are implemented yet.

This is an independent implementation. Protocol conformance has not yet been tested.

Creating this repository does not reserve a name on npm, PyPI, or crates.io.


## Package names

- npm: @poppykit/cli
- Future PyPI distribution: poppykit-cli (Python import: poppykit_cli)
- Future crates.io package: poppykit-cli (Rust library name: poppykit_cli, if applicable)

These are intended names, not reserved registry packages. Python and Rust implementations are not yet present.

