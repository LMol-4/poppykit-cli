# CLI reference

Run `poppykit --help` for commands and [usage](docs/usage.md) for configuration,
secret custody, hosted enrollment, authentication, profiles and exit codes.

`@poppykit/cli` exports the `SecureBackend` type, `encryptedBackend`,
`windowsBackend`, `hiddenInput`, `terminalTrustedInput` and `CliFailure`. The installed
`dist/index.d.ts` and `dist/secrets.d.ts` declarations define the complete seam.
A trusted local module exports `open({purpose,unattended})` returning durable
`secrets` and a `healthCheck`. Optional enrollment authentication, trusted
input, local signer, browser controller and transport remain private operator code.
The backend example in usage is an integration outline: `operatorVault` and
`operatorLogin` are adapters supplied by your application, not bundled services.

Commands never accept Mediated passwords/codes as flags. API commands return
status/target metadata rather than private response bodies/headers. Browser
joining requires an isolated agent-controlled controller. A company/provider URL
cannot select a module to execute.
