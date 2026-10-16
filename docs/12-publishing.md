# Publishing to the Chrome Web Store

1. Developer account: register at https://chrome.google.com/webstore/devconsole (one-time $5 fee, Google account with 2-step verification). Verify your contact email.
2. Build the package: `npm run package`. This runs a release build (minified, no sourcemaps, no dev preview page) and writes `release/usage-meter-for-claude-<version>.zip`. The script prints the zip entries; `manifest.json` must be at the zip root. Regenerate icons with `npm run icons` if the design changes.
3. Host the privacy policy: use `store/PRIVACY.md` via its GitHub URL
   (https://github.com/Naveen022006/claude-usage-teacker-for-devices/blob/main/store/PRIVACY.md) or enable GitHub Pages for a cleaner page. The repo must be public.
4. Dev Console: "Add new item", upload the zip.
5. Store listing tab: copy title, summary, description, category from `store/LISTING.md`; upload screenshots (see `store/SCREENSHOTS.md`) and the 128x128 icon (`src/icons/icon128.png`); optional 440x280 promo tile.
6. Privacy practices tab: paste the single-purpose statement and permission justifications, answer the data-use disclosures, declare no remote code, and add the privacy policy URL, all from `store/LISTING.md`.
7. Distribution: choose visibility (Public, or Unlisted while testing) and regions. Submit for review.

## Review tips
- Broad optional host permissions (`https://*/*`, `http://*/*`) draw scrutiny. The justification says they are requested at runtime for the single user-entered hub URL; keep that wording consistent across listing, policy, and options UI.
- Keep the "unofficial / not affiliated with Anthropic" wording; do not use Anthropic logos or the asterisk mark.
- Reviews usually take a few days to a couple of weeks; first submissions with broad host permissions can take longer.
- If rejected, read the email, fix the cited item, and resubmit.

## Updating versions
1. Bump `version` in `src/manifest.json` and `package.json` (it must increase for every upload).
2. Run `npm test` and `npm run package`.
3. Dev Console, your item, Package, "Upload new package", then resubmit for review.
