# Project instructions for Claude Code

Project: Claude Usage Tracker (per-device 5-hour and weekly usage). Read `README.md` and all of `docs/` first.

Rules:
- Follow `docs/08-phases.md` in order. Phase 0 (experiments) first; propose doc edits and wait for approval.
- The Chrome extension in `extension/` is the main product. The Python collector is optional and secondary.
- Never store, print or transmit: prompt/response content, cookies, auth headers, session ids/tokens,
  org/account ids, IP addresses, API keys. Location strings from the sessions list are OFF by default.
- Identify sessions by a salted hash of (device label + Created time), never by any raw id.
- Do not guess page or endpoint formats. Fail soft: if something cannot be read, record nothing
  and show "could not read" in the UI. Never record a wrong number.
- Poll slowly and politely; no tight loops. Use chrome.alarms (Manifest V3), minimal permissions.
- All attribution output is an estimate and must show a confidence label in the UI.
- Parsers and the attribution engine get fixture tests (no real content or identifiers in fixtures).
- Collector (if built): Python standard library only.
