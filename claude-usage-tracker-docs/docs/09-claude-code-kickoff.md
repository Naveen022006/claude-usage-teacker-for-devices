# 09 - Claude Code kickoff prompt

Create an empty repo, copy this folder in (`README.md`, `CLAUDE.md`, `docs/`), put the existing extension in `extension/`,
start Claude Code in the repo and paste:

```
Read README.md, CLAUDE.md and every file in docs/ first.

We are extending my Chrome extension (./extension) so it shows, for each device in the Claude
account's sessions list, how much of the 5-hour window and the weekly limit that device used.

Start with Phase 0 from docs/08-phases.md, but only the code-reading parts (E1, E6):
1. Read the extension source. Tell me where its usage numbers come from (page element or endpoint),
   what it stores, and how often it reads. Never print cookies, tokens or headers.
2. Tell me how the sessions list could be read by the extension (DOM or endpoint) and whether
   the Current row is detectable. Do not scrape anything with real credentials into files.
3. Propose edits to docs/03, docs/05 and docs/06 where reality differs, and wait for approval.

I will run the live experiments (E2-E5) myself and record the results in docs/10-open-questions.md.
After I approve, build Phase 1 (readers and store) with fixture tests, then stop and summarise.
Do not start Phase 2 until I say so.
```

## Tips
- One phase per Claude Code session.
- Ask for tests to be run and their output shown after every step.
- Commit at the end of every phase.
- Keep live experiment results out of the repo if they contain account details.
