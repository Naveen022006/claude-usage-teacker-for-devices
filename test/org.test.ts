import { describe, expect, it } from "vitest";
import { parseLastActiveOrg, pickOrg, planOfOrgs } from "../src/shared/org";
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

describe("planOfOrgs", () => {
  const org = (uuid: string, capabilities: unknown) => ({ uuid, capabilities });
  it("maps capabilities to a plan", () => {
    expect(planOfOrgs([org(A, ["chat", "claude_max"])], A)).toBe("max");
    expect(planOfOrgs([org(A, ["chat", "claude_pro"])], A)).toBe("pro");
    expect(planOfOrgs([org(A, ["chat", "raven"])], A)).toBe("team");
    expect(planOfOrgs([org(A, ["enterprise"])], A)).toBe("team");
    expect(planOfOrgs([org(A, ["chat"])], A)).toBe("free");
    expect(planOfOrgs([org(A, ["claude_pro", "claude_max"])], A)).toBe("max");
  });
  it("uses the requested org, else the first", () => {
    const json = [org(A, ["chat", "claude_pro"]), org(B, ["chat"])];
    expect(planOfOrgs(json, B)).toBe("free");
    expect(planOfOrgs(json, A.toUpperCase())).toBe("pro");
    expect(planOfOrgs(json, null)).toBe("pro");
  });
  it("returns null for unknown shapes", () => {
    expect(planOfOrgs(null, A)).toBeNull();
    expect(planOfOrgs({}, A)).toBeNull();
    expect(planOfOrgs([org(A, undefined)], A)).toBeNull();
    expect(planOfOrgs([org(B, ["chat"])], A)).toBeNull();
  });
});
