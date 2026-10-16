# Privacy Policy - Usage Meter for Claude

Last updated: 2026-10-16

Usage Meter for Claude ("the extension") is an unofficial browser extension. It is not affiliated with or endorsed by Anthropic.

## What the extension processes

- Counts and metadata about your Claude usage: message counts, estimated token counts, model names, and timestamps.
- Your plan usage and limits, which the extension reads from claude.ai using your own logged-in session (the same data the claude.ai usage page shows you).
- Your settings (device name, optional hub URL and token, display preferences).

## What it never does

- It never reads, stores, or transmits the text of your messages, prompts, files, or Claude's replies. Only lengths and counts are derived from them locally.
- It contains no analytics, advertising, tracking, or third-party SDKs.
- It does not sell or share data with third parties.
- It does not load or execute remote code.

## Where data is stored

All data is processed and stored locally in your browser (chrome.storage). It stays on your device unless you choose to enable the optional hub sync below. You can export or clear all stored data at any time from the options page, and uninstalling the extension removes it.

## Optional hub sync

If, and only if, you configure a Usage Hub URL and token in the options page and enable sync, the extension sends aggregate usage data (counts, model names, timestamps, and your device name) to that hub, authenticated with the token you provided. The hub is operated by you (or whoever you point the extension at); the extension author has no access to it. The extension requests browser permission for that specific address at runtime, only when you set it.

## Network access

The extension communicates only with claude.ai (to read your own usage information using your session) and the hub URL you optionally configure.

## Contact

Questions or requests: https://github.com/Naveen022006/claude-usage-teacker-for-devices/issues

## Changes

Changes to this policy will be published in this file in the repository.
