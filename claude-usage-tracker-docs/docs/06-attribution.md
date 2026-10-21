# 06 - Attribution: who used the points

## Terms
- **Points (pts)**: percentage points of the account's limit (5-hour window or weekly).
- **Interval**: time between two consecutive polls in the same window (same reset time).
- **Active device**: a device with evidence of activity inside an interval.

## Relation to the existing engine (Phase 0 finding)
`src/shared/attribution.ts` already does this split **per model**: it watches each window's % rise between
readings and divides it over the replies seen since the previous reading, weighted by `replyWeight()` (estimated
cost per reply, for this browser's events and for hub token deltas alike). The per-device engine reuses the same
interval logic and weights, and changes only the key (device instead of model) plus adds the sessions-list signal.
Both ledgers must keep the same invariant: sum of rows + Unattributed = observed utilisation for the window.

## Inputs per interval [t0, t1]
1. `delta_pts` = reading(t1) - reading(t0), only when > 0 and both reads belong to the same cycle: reset times
   equal within 2 minutes (`CYCLE_TOLERANCE_MS`; the API's `resets_at` jitters slightly between reads).
2. Session activity: sessions whose `Updated` changed between the two polls.
3. Events: this browser's reply events in the interval (from the existing fetch hook).
4. Claude Code / Claude Desktop token deltas in the interval, per hub device (from the existing Usage Hub).

## Algorithm
```
for each interval with delta_pts > 0:
    A_events  = devices with events
    A_tokens  = devices with Claude Code tokens
    A_updated = devices whose session Updated changed
    A = union(A_events, A_tokens, A_updated)

    if A is empty:
        assign delta to UNATTRIBUTED (method=none)
    elif |A| == 1:
        assign all delta to that device
        confidence = high if from events/tokens, medium if only Updated
    else:
        weights:
          use replyWeight() sums for devices with events or hub tokens (same unit for both),
          devices with only an Updated change get the mean weight of the others (or 1 if none have any),
        assign proportionally, confidence = low (method=split)
```
Device identity: this browser = the Current row (once E1 confirms it is detectable). Hub devices are their own
rows, because the Claude Code CLI may have no sessions-list row at all. When a hub device and a sessions-list row
are the same machine (for example Claude Desktop on this PC), the user merges them in the alias/merge editor.
Totals per window = sum of delta over intervals since the window's reset time. When a reset time changes,
start fresh totals for that window and archive the old ones.

## Reducing ambiguity
- Shorter intervals mean fewer overlaps: poll right after responses and every 1-2 minutes while a tab is open.
- Prefer single-active-device intervals for learning (see calibration below).
- Heartbeat poll even when idle so gaps are visible and labeled "no data" instead of guessed.

## Optional calibration (tokens to points)
`replyWeight()` is a fixed estimate today. Calibration would replace it once there is enough data:
- Use intervals where exactly one device was active to estimate pts per 1k tokens per model.
- Use medians and drop outliers; keep `n_intervals` and a spread measure.
- Under a minimum count (for example 10 intervals) mark every split "low confidence".

## Confidence rules
| Situation | Confidence |
|---|---|
| One active device with direct events or tokens | High |
| One active device, evidence only from Updated | Medium |
| Several active devices, split by tokens or events | Low |
| Several active devices, equal split | Low |
| No evidence | Unattributed |

## Known failure modes (all shown in the UI as Unattributed or Low)
- Updated lags or changes only occasionally, so the real device looks idle.
- Updated changes for background reasons (token refresh) with no real usage, so the device gets credit it did not earn.
- Heavy simultaneous use on two devices.
- Polling gaps (browser closed).
- Usage % rounded to whole numbers makes small intervals noisy.

## Validation (do this before trusting any number)
1. **Single-device test**: use only one device for an hour, others closed. Expect about 90%+ of points on it.
2. **Alternating test**: A for 15 min, B for 15 min, repeat. Check the credit follows.
3. **Conservation check**: per-device points + Unattributed must equal the account change for the window.
4. **Held-out check**: hide 20% of intervals from calibration; compare predictions.
