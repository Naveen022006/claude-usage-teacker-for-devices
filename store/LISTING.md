# Chrome Web Store listing - Usage Meter for Claude

## Title
Usage Meter for Claude

## Short description (summary, max 132 chars)
Unofficial: shows your Claude plan limits and per-model usage in the claude.ai sidebar. Counts only — never message content.

## Category
Productivity (alternative: Developer Tools)

## Language
English

## Long description
Usage Meter for Claude is an unofficial extension that puts your Claude usage where you can see it: right inside the claude.ai sidebar.

Features
- Plan limits at a glance: your 5-hour and weekly limit usage and reset times, read from your own claude.ai session.
- Per-model breakdown: see how much each model (for example Opus, Sonnet, Haiku) is being used on this device.
- Works on claude.ai chat and claude.ai/code, with a compact panel that sits in the sidebar.
- Toolbar popup with a quick summary and a "Sync now" button.
- Optional multi-device view: connect your own Usage Hub to combine usage across your computers.

Privacy first
- Counts only - the extension never reads or stores the text of your messages or Claude's replies.
- Data stays in your browser unless you configure your own hub.
- No analytics, no ads, no third parties, no remote code.

Not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe compatibility.

Source code and support: https://github.com/Naveen022006/claude-usage-teacker-for-devices

## Single purpose
Show the user's Claude plan limits and per-model usage inside the claude.ai interface (and optionally sync usage counts to the user's own hub).

## Permission justifications
- storage: Saves the user's settings and locally computed usage counters (counts, model names, timestamps).
- alarms: Schedules periodic background refresh of usage data and optional sync retries.
- Host permission https://claude.ai/*: Required to display the sidebar panel on claude.ai, to observe response metadata (model name, lengths) for counting, and to read the user's own usage and limit information with their existing session.
- optional_host_permissions https://*/* and http://*/*: Not granted at install. Requested at runtime only for the single hub URL the user types into the options page, so the extension can send aggregate counts to that user-operated server. No other origin is contacted.
- Content script in MAIN world on claude.ai: Needed to read response metadata (model, usage counts) from claude.ai's own requests. Message text is not stored or transmitted.

## Remote code
No. All code is bundled in the package; no remote scripts, eval, or remotely hosted code.

## Data usage disclosures (Privacy practices tab)
Data types collected:
- Personally identifiable information: No
- Health information: No
- Financial and payment information: No
- Authentication information: No (the optional hub token is entered by the user and sent only to the user's own hub; if the form treats that as authentication information, answer Yes and keep the same explanation)
- Personal communications: No (message text is never collected)
- Location: No
- Web history: No
- User activity: Yes - usage counts, model names, timestamps (processed locally; sent only to the user's own hub if enabled)
- Website content: No

Certifications (all must be checked):
- I do not sell or transfer user data to third parties, outside of the approved use cases: Yes
- I do not use or transfer user data for purposes unrelated to the item's single purpose: Yes
- I do not use or transfer user data to determine creditworthiness or for lending purposes: Yes

Privacy policy URL: https://github.com/Naveen022006/claude-usage-teacker-for-devices/blob/main/store/PRIVACY.md
(or a GitHub Pages URL; see docs/12-publishing.md)
