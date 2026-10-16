// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_ATTR, detectMode, findAnchor, isUsableAnchor, labelKey, placeHost, resetAnchorDiagnostics, watchPlacement } from "../src/widget/anchor";

const ok = { usable: () => true };

const CHAT = `
<div id="app"><div class="side"><nav aria-label="Sidebar">
  <div class="rows">
    <div class="r"><a href="/new"><svg></svg><span>New chat</span></a></div>
    <div class="r"><a href="/projects"><svg></svg><span>Projects</span></a></div>
    <div class="r"><a href="/artifacts"><svg></svg><span>Artifacts</span></a></div>
    <div class="r"><a href="/code"><svg></svg><span>Code</span></a></div>
    <div class="r" id="cust"><div><a href="/customize"><svg></svg><span>Customize</span></a></div></div>
  </div>
  <div class="sect"><h2>Pinned</h2><div><a href="/chat/1">First chat</a></div></div>
</nav></div><main>Customize your day. More text</main></div>`;

const CODE = `
<div class="side"><div class="title">Claude Code</div><input placeholder="Search">
 <div class="list">
  <div><button><span>New</span></button></div>
  <div><a href="/code/projects"><span>Projects (Beta)</span></a></div>
  <div><a href="/code/artifacts"><span>Artifacts</span></a></div>
  <div><a href="/code/customize"><span>Customize</span></a></div>
  <div id="more"><div><button type="button"><svg></svg><span>More</span></button></div></div>
  <div class="recents"><div>Recents</div><a href="/code/s1">Session one</a></div>
 </div></div>`;

const OTHER_LANG = `
<nav>
  <a href="/a">Neu</a><a href="/b">Projekte</a><a href="/c">Artefakte</a><a href="/d">Anpassen</a>
  <h3>Angeheftet</h3><a href="/chat/1">Chat</a>
</nav>`;

function setup(html: string): void {
  document.body.innerHTML = html;
}
const mkHost = () => {
  const h = document.createElement("claude-usage-widget");
  h.setAttribute(HOST_ATTR, "");
  return h;
};
const rect = (width: number) => () => ({ width, height: 36, left: 0, right: width, top: 0, bottom: 36, x: 0, y: 0, toJSON() {} }) as DOMRect;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("detectMode", () => {
  it("code only for /code paths", () => {
    expect(detectMode("/code")).toBe("code");
    expect(detectMode("/code/session_1")).toBe("code");
    expect(detectMode("/chat/abc")).toBe("chat");
    expect(detectMode("/")).toBe("chat");
  });
});

describe("findAnchor", () => {
  it("chat: Customize row via href, climbing out of wrapper divs", () => {
    setup(CHAT);
    const a = findAnchor(document, "chat", ok)!;
    expect(a.via).toBe("href");
    expect(a.row.id).toBe("cust");
  });
  it("chat: label match when href is missing", () => {
    setup(CHAT.replace('href="/customize"', 'href="/x"'));
    const a = findAnchor(document, "chat", ok)!;
    expect(a.via).toBe("label");
    expect(a.row.id).toBe("cust");
  });
  it("code: More row, ignoring Customize and the main content text", () => {
    setup(CODE);
    expect(findAnchor(document, "code", ok)!.row.id).toBe("more");
  });
  it("chat fallback: last row before the first section heading in another language", () => {
    setup(OTHER_LANG);
    const a = findAnchor(document, "chat", ok)!;
    expect(a.via).toBe("fallback");
    expect(a.row.textContent).toBe("Anpassen");
  });
  it("code: nav fallback (row before the first section heading) when nothing else matches", () => {
    setup(OTHER_LANG);
    const a = findAnchor(document, "code", ok)!;
    expect(a.via).toBe("fallback");
    expect(a.row.textContent).toBe("Anpassen");
  });
  it("labelKey strips everything but letters", () => {
    expect(labelKey("··· More")).toBe("more");
    expect(labelKey("Projects Beta")).toBe("projectsbeta");
    expect(labelKey(null)).toBe("");
  });
  it("code: More row with svg icon and a dots text node before the label", () => {
    setup(`<nav><a href="/code/customize"><span>Customize</span></a>
      <div id="more"><button type="button"><svg></svg>···<span> More</span></button></div>
      <div><span>Recents</span></div></nav>`);
    const a = findAnchor(document, "code", ok)!;
    expect(a.via).toBe("label");
    expect(a.row.id).toBe("more");
  });
  it("code: More matched through aria-label when hidden text is appended", () => {
    setup(`<nav><a href="/code/customize">Customize</a>
      <div id="more"><button aria-label="More"><svg></svg><span>···</span><span class="sr-only">options</span></button></div>
      <div>Recents</div></nav>`);
    expect(findAnchor(document, "code", ok)!.row.id).toBe("more");
  });
  it("code: More text in a nested span", () => {
    setup(`<nav><div id="more"><div><div role="button"><span><span>More</span></span></div></div></div><div>Recents</div></nav>`);
    expect(findAnchor(document, "code", ok)!.row.id).toBe("more");
  });
  it("code: no More row -> Customize next sibling, unless that is a section heading", () => {
    setup(`<nav><div><a href="/code/customize">Customize</a></div><div id="next"><a href="/code/x">Extra</a></div><div class="h">Recents</div></nav>`);
    let a = findAnchor(document, "code", ok)!;
    expect(a.via).toBe("sibling");
    expect(a.row.id).toBe("next");
    setup(`<nav><div id="cust"><a href="/code/customize">Customize</a></div><div class="h">Recents</div><a href="/code/s1">Session</a></nav>`);
    a = findAnchor(document, "code", ok)!;
    expect(a.row.id).toBe("cust");
  });
  it("code: host placed under Customize moves to More once More renders", () => {
    setup(`<nav><div id="cust"><a href="/code/customize">Customize</a></div><div>Recents</div></nav>`);
    const host = mkHost();
    placeHost(host, document, "/code", ok);
    placeHost(host, document, "/code", ok);
    expect(host.previousElementSibling?.id).toBe("cust");
    document.getElementById("cust")!.insertAdjacentHTML("afterend", `<div id="more"><button><svg></svg>···More</button></div>`);
    placeHost(host, document, "/code", ok);
    expect(host.previousElementSibling?.id).toBe("more");
  });
  it("logs diagnostics once per mode when no anchor is found", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    resetAnchorDiagnostics();
    setup(`<nav><a href="/a">One</a><button>Two</button></nav>`);
    findAnchor(document, "code", ok);
    findAnchor(document, "code", ok);
    findAnchor(document, "chat", ok);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain("sidebar anchor not found (mode=code)");
    expect(spy.mock.calls[0][1]).toEqual(["one", "two"]);
    spy.mockRestore();
  });
  it("missing anchor -> null", () => {
    setup("<nav><a href='/a'>One</a></nav>");
    expect(findAnchor(document, "chat", ok)).toBeNull();
    expect(findAnchor(document, "code", ok)).toBeNull();
  });
  it("collapsed / hidden sidebar is not usable", () => {
    setup(CHAT);
    // happy-dom has no layout: every rect is 0x0, so the default check treats everything as collapsed
    expect(findAnchor(document, "chat")).toBeNull();
    const el = document.getElementById("cust")!;
    el.getBoundingClientRect = rect(60);
    expect(isUsableAnchor(el)).toBe(false);
    el.getBoundingClientRect = rect(260);
    expect(isUsableAnchor(el)).toBe(true);
  });
});

describe("placeHost", () => {
  it("inserts as the next sibling of the row, once", () => {
    setup(CHAT);
    const host = mkHost();
    const r = placeHost(host, document, "/chat/1", ok);
    expect(r.placement).toBe("sidebar");
    expect(document.getElementById("cust")!.nextElementSibling).toBe(host);
    const again = placeHost(host, document, "/chat/1", ok);
    expect(again.changed).toBe(false);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });
  it("re-attaches after React removes it, and drops stray duplicates", () => {
    setup(CHAT);
    const host = mkHost();
    placeHost(host, document, "/", ok);
    host.remove();
    const stray = mkHost();
    document.body.append(stray);
    const r = placeHost(host, document, "/", ok);
    expect(r.changed).toBe(true);
    expect(document.getElementById("cust")!.nextElementSibling).toBe(host);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });
  it("code mode puts it under More; route change moves it", () => {
    setup(CHAT + CODE);
    const host = mkHost();
    placeHost(host, document, "/", ok);
    expect(host.previousElementSibling?.id).toBe("cust");
    const r = placeHost(host, document, "/code/abc", ok);
    expect(r.mode).toBe("code");
    expect(host.previousElementSibling?.id).toBe("more");
  });
  it("falls back to floating on body when sidebar is unusable or missing", () => {
    setup(CHAT);
    const host = mkHost();
    const r = placeHost(host, document, "/", { usable: () => false });
    expect(r.placement).toBe("floating");
    expect(host.parentElement).toBe(document.body);
    setup("<div>nothing</div>");
    expect(placeHost(mkHost(), document, "/code", ok).placement).toBe("floating");
  });
  it("floating host moves into the sidebar once it appears", () => {
    setup("<div>nothing</div>");
    const host = mkHost();
    expect(placeHost(host, document, "/", ok).placement).toBe("floating");
    document.body.insertAdjacentHTML("beforeend", CHAT);
    expect(placeHost(host, document, "/", ok).placement).toBe("sidebar");
    expect(host.previousElementSibling?.id).toBe("cust");
  });
});

describe("watchPlacement", () => {
  it("re-checks after DOM mutations (throttled) and stops cleanly", async () => {
    setup(CHAT);
    const host = mkHost();
    placeHost(host, document, "/", ok);
    const stop = watchPlacement(
      () => {
        placeHost(host, document, "/", ok);
      },
      window,
      10,
    );
    host.remove();
    document.body.append(document.createElement("i")); // trigger a mutation
    await vi.waitFor(() => expect(document.getElementById("cust")!.nextElementSibling).toBe(host), { timeout: 2000 });
    stop();
    host.remove();
    document.body.append(document.createElement("b"));
    await new Promise((r) => setTimeout(r, 80));
    expect(host.isConnected).toBe(false);
  });
});
