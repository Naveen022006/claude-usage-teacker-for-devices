import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/shared/route";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${ID}/`;

describe("routeMessage", () => {
  it("options page opened in a tab -> ui", () => {
    expect(routeMessage({ id: ID, url: ORIGIN + "options.html", tab: { id: 3 } }, ID, ORIGIN)).toBe("ui");
  });
  it("popup (no tab) -> ui", () => {
    expect(routeMessage({ id: ID, url: ORIGIN + "popup.html" }, ID, ORIGIN)).toBe("ui");
  });
  it("claude.ai content script -> content", () => {
    expect(routeMessage({ id: ID, url: "https://claude.ai/chat/1", tab: { id: 1 } }, ID, ORIGIN)).toBe("content");
  });
  it("other extension id -> ignore", () => {
    expect(routeMessage({ id: "other", url: ORIGIN + "options.html", tab: { id: 3 } }, ID, ORIGIN)).toBe("ignore");
    expect(routeMessage({ id: "other", url: "chrome-extension://other/popup.html" }, ID, ORIGIN)).toBe("ignore");
  });
  it("other website tab -> ignore", () => {
    expect(routeMessage({ id: ID, url: "https://example.com/", tab: { id: 2 } }, ID, ORIGIN)).toBe("ignore");
  });
  it("claude.ai-looking page that claims our id but has a non-claude URL -> ignore", () => {
    expect(routeMessage({ id: ID, url: "https://claude.ai.evil.com/x", tab: { id: 2 } }, ID, ORIGIN)).toBe("ignore");
    expect(routeMessage({ id: ID, tab: { id: 2 } }, ID, ORIGIN)).toBe("ignore");
  });
});
