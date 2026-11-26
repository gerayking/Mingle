import { afterEach, describe, expect, it, vi } from "vitest";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

/** The console's shortcut table as one platform and shell see it. */
async function load(userAgent: string, desktop: boolean) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("window", desktop ? { mygo: { call: async () => {} } } : {});
  const { shellAction } = await import("../web/src/shortcuts.ts");
  return (key: string, mods: Mods = {}) => shellAction(press(key, mods));
}

type Mods = Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> & { code?: string };

function press(key: string, mods: Mods = {}): KeyboardEvent {
  return { key, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods } as KeyboardEvent;
}

async function module(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("window", {});
  return import("../web/src/shortcuts.ts");
}

afterEach(() => vi.unstubAllGlobals());

describe("console shortcuts", () => {
  it("uses Command on macOS and Ctrl elsewhere", async () => {
    const mac = await load(MAC, false);
    expect(mac(",", { metaKey: true })).toBe("settings");
    expect(mac("n", { metaKey: true })).toBe("new");
    expect(mac("1", { metaKey: true })).toBe(0);
    expect(mac("9", { metaKey: true })).toBe(8);
    expect(mac("n", { ctrlKey: true })).toBeNull();

    const windows = await load(WINDOWS, false);
    expect(windows(",", { ctrlKey: true })).toBe("settings");
    expect(windows("N", { ctrlKey: true })).toBe("new");
    expect(windows("3", { ctrlKey: true })).toBe(2);
    expect(windows("n", { metaKey: true })).toBeNull();
  });

  it("leaves other combinations and plain keys alone", async () => {
    const mac = await load(MAC, false);
    expect(mac("n")).toBeNull();
    expect(mac("0", { metaKey: true })).toBeNull();
    expect(mac("n", { metaKey: true, shiftKey: true })).toBeNull();
    expect(mac("n", { metaKey: true, altKey: true })).toBeNull();
    // A browser has its own Back and Forward, Close Tab and Quit.
    expect(mac("[", { metaKey: true })).toBeNull();
    expect(mac("w", { metaKey: true })).toBeNull();
  });

  it("leaves the Mac app's menu bar its keys", async () => {
    const app = await load(MAC, true);
    expect(app("n", { metaKey: true })).toBeNull();
    expect(app(",", { metaKey: true })).toBeNull();
    expect(app("w", { metaKey: true })).toBeNull();
    expect(app("q", { metaKey: true })).toBeNull();
    expect(app("2", { metaKey: true })).toBe(1);
    expect(app("[", { metaKey: true })).toBe("back");
    expect(app("]", { metaKey: true })).toBe("forward");
  });

  it("gives the window's own keys to Windows and Linux apps, which have no menu bar", async () => {
    const app = await load(WINDOWS, true);
    expect(app("n", { ctrlKey: true })).toBe("new");
    expect(app("w", { ctrlKey: true })).toBe("close");
    expect(app("q", { ctrlKey: true })).toBe("quit");
    expect(app("ArrowLeft", { altKey: true })).toBe("back");
    expect(app("ArrowRight", { altKey: true })).toBe("forward");
    expect(app("[", { ctrlKey: true })).toBeNull();
  });

  it("switches an agent's tabs and stops it with each platform's keys", async () => {
    const mac = await module(MAC);
    expect(mac.pageAction(press("{", { metaKey: true, shiftKey: true, code: "BracketLeft" }))).toEqual({ tab: 0 });
    expect(mac.pageAction(press("}", { metaKey: true, shiftKey: true, code: "BracketRight" }))).toEqual({ tab: 1 });
    expect(mac.pageAction(press("Tab", { ctrlKey: true }))).toEqual({ tab: 1 });
    expect(mac.pageAction(press("Tab", { ctrlKey: true, shiftKey: true }))).toEqual({ tab: 0 });
    expect(mac.pageAction(press(".", { metaKey: true }))).toBe("stop");
    // ⌘[ without Shift is Back, not a tab.
    expect(mac.pageAction(press("[", { metaKey: true, code: "BracketLeft" }))).toBeNull();
    expect(mac.keysLabel(mac.KEYS.tab(1))).toBe("⇧⌘]");

    const windows = await module(WINDOWS);
    expect(windows.pageAction(press("PageUp", { ctrlKey: true }))).toEqual({ tab: 0 });
    expect(windows.pageAction(press("PageDown", { ctrlKey: true }))).toEqual({ tab: 1 });
    expect(windows.pageAction(press(".", { ctrlKey: true }))).toBe("stop");
    expect(windows.pageAction(press(".", { metaKey: true }))).toBeNull();
    expect(windows.keysLabel(windows.KEYS.tab(0))).toBe("Ctrl+PgUp");
    expect(windows.keysAria(windows.KEYS.tab(1))).toBe("Control+PageDown");
  });

  it("starts the held-modifier hints only for the modifier alone", async () => {
    const mac = await module(MAC);
    expect(mac.isModifierAlone(press("Meta", { metaKey: true }))).toBe(true);
    expect(mac.isModifierAlone(press("Meta", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(mac.isModifierAlone(press("Control", { ctrlKey: true }))).toBe(false);
    const windows = await module(WINDOWS);
    expect(windows.isModifierAlone(press("Control", { ctrlKey: true }))).toBe(true);
    expect(windows.isModifierAlone(press("Meta", { metaKey: true }))).toBe(false);
  });
});
