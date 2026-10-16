# PoppyKit cli

Command-line interface for personal-agent runtimes, built on the Poppy client SDK.

An optional adapter for runtimes that execute commands, including the Codex demo.
Products integrating the client SDK directly do not need this CLI. Protocol logic
belongs in the client SDK; local demo startup and company-agent setup belong in
[poppykit-demo](https://github.com/LMol-4/poppykit-demo).

Status: initial project scaffold. No SDK or CLI implementation is published yet.

Targets the Personal Agent Protocol (Poppy): https://personalagentprotocol.org/docs/spec

This is an independent implementation. Protocol conformance has not yet been tested.

Creating this repository does not reserve a name on npm, PyPI, or crates.io.


## Package names

- npm: @poppykit/cli
- Future PyPI distribution: poppykit-cli (Python import: poppykit_cli)
- Future crates.io package: poppykit-cli (Rust library name: poppykit_cli, if applicable)

These are intended names, not reserved registry packages. Python and Rust implementations are not yet present.

