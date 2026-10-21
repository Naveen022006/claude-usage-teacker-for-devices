# 06 - Attribution: who used the points

## Terms
- **Points (pts)**: percentage points of the account's limit (5-hour window or weekly).
- **Interval**: time between two consecutive polls in the same window (same reset time).
- **Active device**: a device with evidence of activity inside an interval.

## Inputs per interval [t0, t1]
1. `delta_pts` = reading(t1) - reading(t0), only when > 0 and both reads share the same reset time.
2. Session activity: sessions whose `Updated` changed between the two polls.
3. Events: browser send events in the interval (per install/device).
4. Claude Code tokens in the interval (per device), if the collector is used.

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
          use token shares where tokens exist (scaled by fitted tokens-per-pt, see below),
          else event counts,
          else equal split among A_updated
        assign proportionally, confidence = low (method=split)
```
Totals per window = sum of delta over intervals since the window's reset time. When a reset time changes,
start fresh totals for that window and archive the old ones.

## Reducing ambiguity
- Shorter intervals mean fewer overlaps: poll right after responses and every 1-2 minutes while a tab is open.
- Prefer single-active-device intervals for learning (see calibration below).
- Heartbeat poll even when idle so gaps are visible and labeled "no data" instead of guessed.

## Optional calibration (tokens to points)
Only needed to weight splits when Claude Code tokens exist on several devices:
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
