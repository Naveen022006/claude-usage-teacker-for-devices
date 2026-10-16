// ISOLATED world content script: relays validated page messages to the service worker.

const TYPES = new Set(["usage-event", "org-seen", "limit-hint"]);

window.addEventListener("message", (event: MessageEvent) => {
  try {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data as { ns?: unknown; type?: unknown } | null;
    if (!d || typeof d !== "object" || d.ns !== "deskbuddy" || typeof d.type !== "string" || !TYPES.has(d.type)) return;
    chrome.runtime.sendMessage(d).catch(() => {});
  } catch {
    /* extension context invalidated etc. */
  }
});
