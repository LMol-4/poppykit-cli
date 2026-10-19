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
