import { describe, expect, it } from "vitest";
import { parseLastActiveOrg, pickOrg } from "../src/shared/org";
import { validateWidgetRequest } from "../src/shared/validate";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseLastActiveOrg", () => {
  it("finds the uuid among other cookies", () => {
    expect(parseLastActiveOrg(`foo=1; lastActiveOrg=${A}; bar=2`)).toBe(A);
    expect(parseLastActiveOrg(`lastActiveOrg=${A}`)).toBe(A);
  });
  it("rejects missing / malformed values", () => {
    expect(parseLastActiveOrg("")).toBeNull();
    expect(parseLastActiveOrg(null)).toBeNull();
    expect(parseLastActiveOrg("x=1")).toBeNull();
    expect(parseLastActiveOrg("lastActiveOrg=nope")).toBeNull();
    expect(parseLastActiveOrg("xlastActiveOrg=" + A)).toBeNull();
  });
});

describe("pickOrg", () => {
  it("prefers the hint, then a chat-capable org, then the first", () => {
    const list = [{ uuid: A, capabilities: ["api"] }, { uuid: B, capabilities: ["chat"] }];
    expect(pickOrg(list, A)).toBe(A);
    expect(pickOrg(list, null)).toBe(B);
    expect(pickOrg([{ uuid: A }, { uuid: B }], "zzz")).toBe(A);
  });
  it("is defensive about shape", () => {
    expect(pickOrg(null)).toBeNull();
    expect(pickOrg({ uuid: A })).toBeNull();
    expect(pickOrg([null, 3, { uuid: 5 }, { uuid: "bad id!" }])).toBeNull();
    expect(pickOrg([null, { uuid: A, capabilities: "chat" }])).toBe(A);
  });
});

describe("validateWidgetRequest orgHint", () => {
  it("keeps only valid hints", () => {
    expect(validateWidgetRequest({ ns: "claude-usage", type: "get-widget-state", orgHint: A })).toEqual({ ns: "claude-usage", type: "get-widget-state", orgHint: A });
    expect(validateWidgetRequest({ ns: "claude-usage", type: "get-widget-state", orgHint: "../x" })).toEqual({ ns: "claude-usage", type: "get-widget-state" });
  });
});
