# 08 - Phases

## Phase 0 - Experiments (decide feasibility, 1-2 hours)
- [ ] **E1 Read the sessions list**: where does the data come from (DOM or an endpoint the page calls)? Which fields are readable? Is the Current row detectable?
- [ ] **E2 Updated semantics**: send one message from device A, reload the list, note which row's Updated changed and how long it took. Repeat on devices B, C (Claude Desktop, iOS). Do idle sessions change Updated on their own (token refresh)?
- [ ] **E3 Usage % granularity**: how precise are the 5-hour and weekly values (whole numbers or decimals)? How fast do they move after a message?
- [ ] **E4 Single-device control**: use only one device for 30-60 minutes, log % before/after. Gives the noise floor.
- [ ] **E5 Row mapping**: how many physical machines are behind the three Claude Desktop rows? Decide aliases/merges.
- [ ] **E6 Polling cost**: confirm that reading every 1-2 minutes is acceptable and stable.
- [ ] Record results in `10-open-questions.md` and edit docs 03, 05, 06 if reality differs.
Go/no-go: if Updated never reflects real use, attribution falls back to events and logs only; say so in the UI.

## Phase 1 - Readers and store
- [ ] Usage reader with history.
- [ ] Session reader, Current detection, salted hashing, session_updates.
- [ ] IndexedDB store, retention, "Delete all data".
- [ ] Fixture tests for both parsers.

## Phase 2 - Attribution engine (single-instance mode)
- [ ] Interval builder, algorithm in `06-attribution.md`, confidence labels, conservation check.
- [ ] Unit tests with synthetic scenarios (one device, two devices, no evidence, window reset).

## Phase 3 - UI
- [ ] Per-device table, window bars, timeline, daily breakdown.
- [ ] Alias and merge editor, options page.
- [ ] Export JSON.

## Phase 4 - Validation
- [ ] Single-device and alternating tests; record accuracy in `10-open-questions.md`.
- [ ] Tune polling and weighting.

## Phase 5 - Multi-instance and sync (optional)
- [ ] Event recorder (if feasible with minimal permissions).
- [ ] Central store (Cloudflare Worker + D1 or Supabase), per-install tokens, shared sessions/readings.
- [ ] Extension installs on each browser; merge by device.

## Phase 6 - Claude Code collector (optional)
- [ ] Parse logs into `cc_usage` (see `04-collector-spec.md`), import into the extension store or central store.
- [ ] Use tokens as the strongest evidence in attribution.

## Phase 7 - Polish (optional)
- [ ] Injected columns on the settings page.
- [ ] Threshold alerts (for example weekly total above 80%).
- [ ] README with screenshots.
