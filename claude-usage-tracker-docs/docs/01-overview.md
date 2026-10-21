# 01 - Overview

## Problem
The account settings list every signed-in device/session (for example Edge on Windows, Chrome on Mac,
three Claude Desktop sessions on Windows, Chrome on Windows, Claude on iOS) with Location, Created and
Updated. Separately it shows pooled plan usage (5-hour session %, weekly %). Nothing connects the two:
you cannot see how much of the limit each device used.

## Goal
Extend that devices list with two numbers per device, in the same layout:
- **5-hour used**: points of the current 5-hour window consumed by this device.
- **Weekly used**: points of the current weekly limit consumed by this device.
Both reset when the corresponding window resets, plus an "Unattributed" row and an account total.

## Scope (v1)
- Chrome (and Edge, Chromium-based) extension reading usage % and the sessions list.
- Attribution engine inside the extension (runs locally).
- Per-device table + charts in an extension page.
- Optional: injecting the two columns into the Claude settings page itself.
- Optional: Claude Code collector for precise per-device token evidence.

## Non-goals
- Official or exact per-device quota numbers (they do not exist).
- Running inside Claude Desktop or the iOS app (no extension support there). Those devices are
  attributed only through the sessions list and logs.
- Reading conversation content.
- Team or multi-user use.

## Success criteria
- In a controlled test (use only one device for an hour), that device receives at least 90% of the points.
- With two devices used alternately, each is credited correctly in most intervals.
- The sum of per-device points plus Unattributed equals the account's observed change.
- Every figure shown carries a confidence label.

## Honest limits
- The result is only as good as the "Updated" activity signal and polling frequency (verify in Phase 0).
- Simultaneous use on several devices cannot be split exactly.
- Sessions that never change their Updated time look idle even when used.
