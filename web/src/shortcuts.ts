import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Keyboard shortcuts of the console, the same on every platform with the platform's modifier:
 * Command on macOS, Ctrl on Windows and Linux. See DESIGN.md, "键盘".
 */
export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Mygo {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
}

function mygo(): Mygo | undefined {
  return (window as { mygo?: Mygo }).mygo;
}

/**
 * In the Mac app the menu bar owns New Agent, Settings, Close Window and Quit (desktop/main.go):
 * the page leaves those keys to it, so that one press does not run twice.
 */
const menuBarOwns = (): boolean => isMac && mygo() !== undefined;

/** Command on macOS, Ctrl elsewhere, without the other one. */
export function withMod(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** A shortcut as the console shows it: the platform's modifier, maybe Shift, and a key. */
export interface Keys {
  key: string;
  shift?: boolean;
}

/** How a shortcut reads: "⌘N" and "⇧⌘]" on macOS, "Ctrl+N" and "Ctrl+PgDn" elsewhere. */
export function keysLabel({ key, shift }: Keys): string {
  return isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** The same for `aria-keyshortcuts`. */
export function keysAria({ key, shift }: Keys): string {
  const name = { PgUp: "PageUp", PgDn: "PageDown" }[key] ?? key;
  return `${isMac ? "Meta" : "Control"}+${shift ? "Shift+" : ""}${name}`;
}

/** The console's shortcuts that have a button, for its tooltip and the held-modifier hints. */
export const KEYS = {
  newAgent: { key: "N" },
  settings: { key: "," },
  agent: (index: number): Keys | undefined => (index < 9 ? { key: String(index + 1) } : undefined),
  // An agent page's previous (0) and next (1) tab: macOS's Show Previous / Next Tab; Ctrl+Page Up / Down elsewhere.
  tab: (index: number): Keys =>
    isMac ? { key: index === 0 ? "[" : "]", shift: true } : { key: index === 0 ? "PgUp" : "PgDn" },
  // Command-period cancels on macOS; the same key elsewhere.
  stop: { key: "." },
} satisfies Record<string, Keys | ((index: number) => Keys | undefined)>;

export interface ShellShortcuts {
  newAgent: () => void;
  settings: () => void;
  /** The agent at this place in the sidebar, from 0. */
  agent: (index: number) => void;
  /** Escape with nothing else to close it: the sidebar opened over the page on narrow windows. */
  escape: () => void;
}

/** The shell's own shortcuts, listened for on the whole window. */
export function useShellShortcuts(handlers: ShellShortcuts): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const h = current.current;
      if (event.key === "Escape") {
        if (!event.metaKey && !event.ctrlKey && !event.altKey) h.escape();
        return;
      }
      const action = shellAction(event);
      if (action === null) return;
      event.preventDefault();
      if (action === "new") h.newAgent();
      else if (action === "settings") h.settings();
      else if (action === "back") history.back();
      else if (action === "forward") history.forward();
      else if (action === "close") void mygo()?.call("Shell.CloseWindow");
      else if (action === "quit") void mygo()?.call("Shell.Quit");
      else h.agent(action);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

type Action = "new" | "settings" | "back" | "forward" | "close" | "quit" | number;

/** Which shortcut a key press is, if any. */
export function shellAction(event: KeyboardEvent): Action | null {
  const desktop = mygo() !== undefined;
  // A browser has its own Back and Forward; the app's window has none.
  if (desktop && !isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === "ArrowLeft") return "back";
    if (event.key === "ArrowRight") return "forward";
  }
  if (!withMod(event) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return null;
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  if (desktop && isMac && key === "[") return "back";
  if (desktop && isMac && key === "]") return "forward";
  if (menuBarOwns()) return null;
  if (key === "n") return "new";
  if (key === ",") return "settings";
  // Windows and Linux windows have no menu bar to hold these: the page asks the app.
  if (desktop && key === "w") return "close";
  if (desktop && key === "q") return "quit";
  return null;
}

/** Escape backs out of what the element belongs to, as a form being edited or a question asked. */
export function onEscape(run: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // Handled here: the shell's Escape does not also close the sidebar.
    event.preventDefault();
    run();
  };
}

/**
 * An agent page's own keys: the previous (0) or next (1) tab, or stopping what it does. Ctrl+Tab
 * and Ctrl+Shift+Tab switch tabs on every platform too.
 */
export function pageAction(event: KeyboardEvent): { tab: 0 | 1 } | "stop" | null {
  if (event.altKey) return null;
  if (event.ctrlKey && !event.metaKey && event.key === "Tab") return { tab: event.shiftKey ? 0 : 1 };
  if (!withMod(event)) return null;
  if (isMac && event.shiftKey && event.code === "BracketLeft") return { tab: 0 };
  if (isMac && event.shiftKey && event.code === "BracketRight") return { tab: 1 };
  if (!isMac && !event.shiftKey && event.key === "PageUp") return { tab: 0 };
  if (!isMac && !event.shiftKey && event.key === "PageDown") return { tab: 1 };
  if (!event.shiftKey && event.key === ".") return "stop";
  return null;
}

/** Listens for the page's keys while it is shown. */
export function usePageShortcuts(handlers: { tab: (index: 0 | 1) => void; stop: () => void }): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = pageAction(event);
      if (action === null) return;
      event.preventDefault();
      if (action === "stop") current.current.stop();
      else current.current.tab(action.tab);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Holding the modifier alone for a moment shows every button's shortcut beside it, and letting
 * go hides them, as Windows shows its access keys while Alt is held. A quick ⌘C never shows them.
 */
export const HINT_DELAY = 500;

let hinting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setHinting(on: boolean) {
  clearTimeout(timer);
  if (hinting === on) return;
  hinting = on;
  for (const listener of listeners) listener();
}

/** The modifier itself, held alone: the start of a hint. */
export function isModifierAlone(event: KeyboardEvent): boolean {
  const modifier = isMac ? event.key === "Meta" : event.key === "Control";
  return modifier && !event.shiftKey && !event.altKey && (isMac ? !event.ctrlKey : !event.metaKey);
}

const onDown = (event: KeyboardEvent) => {
  if (!isModifierAlone(event)) return setHinting(false);
  if (event.repeat || hinting) return;
  clearTimeout(timer);
  timer = setTimeout(() => setHinting(true), HINT_DELAY);
};
const hide = () => setHinting(false);

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    addEventListener("keydown", onDown, true);
    addEventListener("keyup", hide, true);
    addEventListener("pointerdown", hide, true);
    addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    removeEventListener("keydown", onDown, true);
    removeEventListener("keyup", hide, true);
    removeEventListener("pointerdown", hide, true);
    removeEventListener("blur", hide);
    document.removeEventListener("visibilitychange", hide);
    setHinting(false);
  };
}

/** Whether the shortcuts show beside their buttons now. */
export function useShortcutHints(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hinting,
    () => false,
  );
}
