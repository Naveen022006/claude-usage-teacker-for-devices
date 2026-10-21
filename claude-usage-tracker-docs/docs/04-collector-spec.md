> **Optional component.** The extension works without this. Build it only if you want exact per-device
> token evidence for Claude Code (laptop, VM, old phone). It feeds the `cc_usage` table in
> `03-data-model.md` and is used by `06-attribution.md` as the strongest evidence for Claude Code activity.
> The `usage` table below is the same data as `cc_usage`; use `cc_usage` as the shared name when importing.

# 04 - Collector spec

## Responsibilities
1. Find session logs under the configured roots.
2. Parse only new bytes since the last run.
3. Upsert usage rows tagged with the device name.
4. Import extension snapshots.
5. Export JSON for the dashboard.

## Config (`config.toml`)
```toml
device = "laptop"
roots  = ["~/.claude/projects"]
db     = "~/.claude-usage/usage.db"
hash_project_names = true
```

## CLI
```
collector scan                         # parse new log data
collector import-snapshots FILE        # load extension export (JSON or CSV)
collector calibrate                    # recompute estimates (see 06)
collector export --bucket day --out-dir ./site
collector stats                        # rows, skipped, last scan, last snapshot per device
collector sync                         # phase 5
```

## Parsing rules
- Stream line by line; never load a whole file (phones are small).
- Invalid JSON: count as `skipped`, continue. Do not advance the offset past an incomplete last line.
- Process only lines with a usage object and a model. Skip synthetic/placeholder models if the log marks them.
- Missing token fields count as 0. Convert time to UTC.
- If a file shrinks below the stored offset, reset to 0 (dedupe makes re-reads safe).

## Privacy checklist (phase 1 gate)
- [ ] No code path stores `message.content` or tool output.
- [ ] Project path hashed or reduced to a basename.
- [ ] Exports contain only counts, model names, device names and times.
- [ ] Importer rejects any snapshot field it does not recognise (no cookies or tokens can slip in).

## Scheduling
cron every 10 minutes (`*/10 * * * * python3 /path/collector scan`), or a `sleep 600` loop on the phone.

## Tests
Fixture JSONL: duplicates, a malformed line, a truncated last line, two models, missing cache fields.
Assert row count, sums, and no double-count after two scans. Fixture snapshots: missing fields, duplicates.
