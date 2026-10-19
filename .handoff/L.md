# L checkpoint

## Assignment
- Agent: L; assignment L1-20261019; agent /root/l; integration lead I /root.
- Stories: L1 proposal (review); L2-L4 not started.
- Worktree: C:/code/poppy/.worktrees/l-cli; repository C:/code/poppy/repos/poppykit-cli.
- Branch agent/l/host-contract; base 2ad2501; interface v1 proposal only.
- Owned: src except shared exports, tests, docs/host-contract.md, .handoff/L.md.

## Durable checkpoint
- Latest implementation SHA: e7d7816; proposal committed.
- Completed: versioned operations/types, wire framing and safety semantics, three fixtures.
- Remaining: consumer approval, runtime client/CLI/profile/replay implementation, tests and independent review.
- Dirty work: none after this checkpoint commit; no previous edits overwritten.
- Processes: none. No uncertain side effects.

## Validation
- Repository inspected using git status/log; clean initial state at assigned base.
- Validation: Get-Content tests/fixtures/host-contract.json -Raw | ConvertFrom-Json | Measure-Object passed, 3 fixtures, at e7d7816 content. Typecheck pending tooling from I.
- No runtime tests claimed; no runtime implementation allowed before gate.

## Review/handoff and recovery
- Reviewer: I/H gate; R send/ack semantics; approval pending.
- Pending config: isolated host-contract package subpath and CLI executable wiring by I.
- Blocker: shared-interface gate; protected Windows pipe ACL/peer boundary requires H/D implementation agreement.
- Next step: I/H review e7d7816; receive interface gate approval from I before runtime implementation. Proposal SHA reported to I.
- Inspect git status/log and this checkpoint before resuming. No pushes/publication.


## Revised proposal checkpoint
- Implementation SHA: 5326688; tooling c1abe14 merged under I authorization.
- Added discovery(domain), connection.start(domain), mutually exclusive connection/domain login.start; fixtures now cover signed-out flow.
- Documented explicit new conversation.send for resumption and private-only WWW-Authenticate/DPoP-Nonce retention.
- Validation: node C:/code/poppy/.worktrees/integration/poppykit-cli/node_modules/typescript/bin/tsc --noEmit --typeRoots C:/code/poppy/.worktrees/integration/poppykit-cli/node_modules/@types passed (5326688 content).
- Validation: Get-Content tests/fixtures/host-contract.json -Raw | ConvertFrom-Json | Measure-Object passed: 5 fixtures.
- Local install: node scripts/pnpm.mjs install --offline --frozen-lockfile failed missing offline metadata. Following pnpm typecheck attempted dependency download, network EACCES; process 74667 stopped with Ctrl-C. Used existing integration compiler read-only instead.
- Dirty/untracked: none after checkpoint commit; ignored partial node_modules may remain from attempted install.
- Next: Q review 5326688 and I gate authorization; no runtime implementation yet.

## Independent N proposal review
- Reviewed immutable client SHA 3b16ab44f268cda065b48456fdfe19c9a87a56a5, docs/network-interface.md, for CLI/host consumption only.
- No blocking findings; proposal approved within L consumer scope. Wire snake_case six-field page stays unchanged under result.page; pinned spec.mdx lines 1431-1433 confirm cursor semantics.
- Domain discovery and no-vault/web-only behavior align with host discovery/connection.start. Abort means stop waiting, not remote work cancellation. SDK retains private headers, CLI excludes challenges/nonces.
- Integration caveat sent to I: N default total timeout 15s must be overridden for 30s host long polls, e.g. transport 32s below 35s outer command deadline. No runtime/security implementation approval.
- Own implementation remains 5326688; checkpoint bc9d3b9 preserved. Worktree clean before this record. No processes started or install attempted during resumed review.
- Next: await Q revised host review and I shared-interface gate. Runtime still gated.
