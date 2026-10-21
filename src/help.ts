export const HELP = String.raw`Usage: poppykit <command> [options]

Local commands (no host required):
  help | --help
  profile add <name> --pipe <local-pipe> [--connection <connection>]
  profile list
  profile remove <name>
  Example local pipe: \\.\pipe\poppykit-demo

Host commands (append --profile <name> to select a configured host):
  discovery <domain>
  connect <domain>
  connections
  login --scope <scope> [--scope <scope> ...] --connection <connection>
  login --scope <scope> [--scope <scope> ...] --domain <domain> [--replace <connection>]
  status <operation> [--login]
  cancel <login-operation>
  logout [--connection <connection>]
  start [message options] [--connection <connection>]
  send <conversation> [message options] [--connection <connection>] [--cursor <cursor>]
  direct <parent-conversation> [message options] [--connection <connection>]
  read <conversation> [--connection <connection>] [--cursor <cursor>] [--wait <seconds>] [--consumer <name>]
  ack <conversation> --consumer <name> --cursor <cursor> [--connection <connection>]
  handoff <conversation> [--connection <connection>]
  close <conversation> [--connection <connection>]

Message options for start, send and direct:
  --text <text>       Message text; provide at least one of text, data or context.
  --data <json>       JSON object (maximum nesting depth 64).
  --context <json>    JSON object (maximum nesting depth 64).
  --human            Mark exact human text; otherwise sender is agent.
  --message-id <id>   Caller-supplied message ID; otherwise generated.
  --send-operation <handle>  Persisted send identity; otherwise generated.
  --wait <seconds>   Integer 0..30 (also supported by read).
  IDs/handles supplied above must match [A-Za-z0-9._-]{1,128}.

One configured profile is selected automatically; otherwise pass --profile.
--connection overrides the profile's default connection. Login without --domain
needs an explicit or profile connection. Other conversation/account commands let
the host resolve an omitted connection; ambiguity is an error.
Direct creates a linked child conversation. Read does not acknowledge processing:
use ack to advance a named consumer after processing its page.

Recovery:
  Inspect status <operation>; use --login for login progress.
  On an uncertain send, inspect status <send-operation> before retrying.
  Retry with the SAME command and saved handle, without message/target options:
    start --send-operation <handle> [--profile <name>] [--wait <seconds>]
    send --send-operation <handle> [--profile <name>] [--wait <seconds>]
    direct --send-operation <handle> [--profile <name>] [--wait <seconds>]
  Use the original host/profile. Saved content, target and message ID are reused.
  Never assume an uncertain outcome failed or resend with a new identity.
  After login, explicitly send the authorized question again; polling does not
  resume it. Cancel stops login intent; logout disconnects account access and
  reports remote revocation progress; close ends only the conversation.

Output: help is plain text, exits 0, and does not read or write local state.
All other commands emit one JSON result on stdout; diagnostics go to stderr.
Exit codes: 0 succeeded/accepted/pending, 1 failed (including uncertain), 2 invalid invocation.
State: POPPYKIT_HOME, or %LOCALAPPDATA%\poppykit-cli (home directory fallback).
Host access requires Windows and PowerShell 7 (pwsh); help works offline.
`;
