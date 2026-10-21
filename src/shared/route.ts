// Decides who sent a runtime message (pure; no chrome.*). Routing by sender URL, not by `sender.tab`:
// the Options page (`options_page` opens in a TAB) and a popup opened in a tab are extension pages too.

export type MessageRoute = "ui" | "content" | "ignore";

export function routeMessage(sender: { id?: string; url?: string; tab?: unknown }, extId: string, extOrigin: string): MessageRoute {
  if (!extId || sender.id !== extId) return "ignore";
  const url = sender.url ?? "";
  if (extOrigin && url.startsWith(extOrigin)) return "ui";
  if (sender.tab && url.startsWith("https://claude.ai/")) return "content";
  return "ignore";
}
