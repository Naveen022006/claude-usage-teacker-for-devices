# 07 - Dashboard spec (extension page)

## 1. Per-device table (mirrors the settings list)
Columns: Device | Location (optional) | Created | Updated | **5h used** | **Weekly used** | Confidence | Status.
```
Device                 Created   Updated   5h used (pts / share)   Weekly used (pts / share)  Conf.
Chrome (Windows) now   Oct 11    9:52 AM   9 / 56%                 14 / 40%                   High
Claude Desktop (Win)   Oct 7     9:42 AM   4 / 25%                  6 / 17%                   Medium
Claude (iOS)           Oct 9     Oct 20    1 / 6%                   2 / 6%                    Low
Unattributed           -         -         2 / 13%                  13 / 37%                  -
Account total          -         -         16                       35                        -
```
(example numbers only)
- "pts" = points of the account limit. "share" = share of what has been used so far in that window.
- Rows for the same physical device can be merged by the user.
- Status: active now / idle / stale (no reading recently).
- Show window reset times above the table: "5h window resets at ...", "Weekly resets at ...".

## 2. Charts
- **Current window bars**: stacked bar per window (5h and weekly), one segment per device + Unattributed.
- **Timeline**: account % over time with stacked area of per-device contribution for the last 5 hours / 7 days.
- **Daily weekly breakdown**: points per device per day within the week.
- **Evidence view** (debug): for a chosen interval, show delta, active sessions and method used.

## 3. Controls
Window (5h | weekly), range, device merge/alias editor, show/hide Unattributed, export JSON.

## 4. UX rules
- Every figure carries a confidence badge; tooltips explain the method used.
- Consistent device colors across charts.
- Empty state with setup steps if no readings exist; "could not read" state if the page structure changed.
- Show last successful read time everywhere.
- Footer: "Per-device figures are estimates based on session activity and usage changes. Anthropic does not
  publish per-device usage."

## 5. Optional: columns on the settings page
Content script adds "5h used" and "Weekly used" to the existing devices table, matched by (label + Created).
Toggle in options; remove silently if the table structure is not recognised.
