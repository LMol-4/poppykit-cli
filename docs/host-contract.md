# Command host contract v1 (proposal awaiting I/H gate)

The package subpath `@poppykit/cli/host-contract` exports `src/host-contract.ts` independently of the executable. No SDK or demo dependency is required. I owns export/build wiring.

One UTF-8 JSON request and one JSON response per channel connection, each terminated by LF, maximum 8 MiB encoded frame. No progress stream: callers inspect durable operation handles using `operation.status` or `login.status`. Response version/requestId/operation must match. Unknown version produces `version_mismatch`; unknown operations/fields and invalid parameters produce `invalid_input`. No automatic transport retry of mutating commands. Connect timeout 5 seconds, request timeout 35 seconds, host waits capped at 30 seconds.

Only local Windows named pipes (`\\.\pipe\...`) are permitted. Profiles contain public configuration only. Host must restrict pipe ACL to the authenticated Windows user and SYSTEM and reject remote clients; user binding is derived from authenticated channel identity, never request parameters. Node's ordinary pipe listener alone does not prove ACL/peer identity; H/D must provide and test that protected server boundary. No unauthenticated TCP fallback. Another platform requires a separately reviewed protected local transport.

Handles are opaque nonempty strings, scoped to host authenticated user. Connection ambiguity produces conflict plus `select_connection`; host never picks an arbitrary account. An explicit profile connection is forwarded, never treated as identity authority. Conversation IDs, send-operation IDs and operation progress handles are public; credentials, assertions, authorization codes, PKCE, raw callback URLs and private keys are excluded. Host launches browser/UI itself.

The operations and typed inputs are in the type module. `conversation.ack` is separate from read: named consumer checkpoints only advance after explicit processing acknowledgement. Messages require at least one of text/data/context and preserve supplied JSON and sender. `human` is only exact human text. Direct means create a linked child under the supplied parent, using the supplied initial message.

CLI persists a generated send-operation handle and message ID/content/target before contacting host; explicit caller IDs are accepted. Reusing a send handle with changed content/linkage is conflict. The host durably associates sendOperation with SDK outbound operation before remote dispatch. An invocation requestId identifies one command attempt, not outbound message identity. Retry/restart uses the saved sendOperation/message ID. No automatic replay after ambiguous transport failure; output returns uncertain outcome and the public handle for explicit inspection/retry.

Success/accepted/pending has result and no error; failed has error (safe public result may additionally carry recovery handles). Result is a public JSON object: connection listing uses `connections`; login/logout/progress uses `operation`, `state`, `connection` when known; messages use `sendOperation`, `conversation`, `page`; reads use `page`. Pages preserve all six SDK fields and unknown events as low-level data, never execute or send unknown payloads automatically to a model. Login states: pending, completed, denied, expired, cancelled, failed, uncertain. Logout reports disconnected separately from remote revocation state pending/completed/uncertain. A terminal denied/cancelled/expired/uncertain login is failed, not succeeded.

`login.cancel` cancels sign-in intent only. Closing a pipe or interrupting CLI cancels waiting, not remote work; host can observe channel closure to abort a pending read. `logout` disconnects account use with explicit remote cleanup progress. `conversation.close` closes that conversation. These actions are never aliases. Progress inspection cannot restart consent or resume suspended company work.

CLI emits exactly one response JSON value to stdout, including safe invocation/transport errors; stderr carries redacted diagnostics. Exit 0: succeeded/accepted/pending. Exit 1: operation failure, including uncertainty. Exit 2: invalid invocation. The local error representation uses the selected operation, or `connection.list` when parsing never identified one, and a generated requestId. Protocol HTTP status/error code/Retry-After remain separate in `error.protocol`; never put raw peer bodies or unsanitized error strings in diagnostics.

Fixtures are independently implementable examples, not a runtime conformance claim. Remaining gate review: I/H acknowledge operations, framing, ACL provider, result field names and SDK page shape; R acknowledges send and acknowledgment semantics.

## Revised signed-out and discovery boundary

`discovery({domain})` returns validated public discovery metadata without constructing a session or requiring a vault. `connection.start({domain})` discovers services and creates a signed-out connection/session, returning the public `connection` handle. The host persists both selected service domain and exact full issuer on that connection. Discovery supports web-only domains; a conversation command on a domain without that capability returns unsupported_capability.

`login.start` either takes an existing explicit `connection` plus scopes, or `domain` plus scopes and optional `replaceConnection` to stage a new connection. These forms are mutually exclusive. Issuer-only input is rejected: it loses service-domain discovery. Replacement activates only after successful sign-in/persistence and actual scope checks; failed replacement preserves the old connection. All follow-up operations select the resulting connection handle.

After sign-in, explicit resumption is a new `conversation.send` containing a new user-authorized message. Login completion, progress inspection and conversation polling must never restart suspended company work. There is no protocol resume command.

The SDK/host retain validated HTTP WWW-Authenticate and DPoP-Nonce headers privately for bounded authentication handling; they are not copied into command results or stderr. Public protocol failures expose status, code, validated Retry-After, and validated extension/conversation_id recovery identifiers. Raw challenge text and nonce values never enter CLI output or model context.


## Frame and timeout integration

The host validates encoded UTF-8 size after serialization and before writing any response bytes. The 8 MiB command frame budget accommodates JSON envelope overhead around N's maximum 1 MiB remote body. A response still exceeding the limit becomes a bounded failed response with category `oversized_result`, fixed safe text, and public operation/send handles when available. It is a recoverable local transport/output failure: it does not imply remote mutation failed. Do not advance a named consumer checkpoint or acknowledge a page that was not delivered. Inspection/retry retains the original send identity; use supported peer pagination controls only, never invent a Poppy page-size parameter. Both endpoints also bound JSON structural depth to 64 before recursive validation/processing; deeply nested input is invalid_input, excessive result nesting is oversized_result.

H configures N transport total timeout to 32 seconds for host reads capped at 30 seconds, below the CLI outer request timeout of 35 seconds. Ordinary short requests can retain N's default 15 seconds. Host page values use exact wire snake_case fields, including unknown event properties; no reshaping into the earlier illustrative camelCase draft.
