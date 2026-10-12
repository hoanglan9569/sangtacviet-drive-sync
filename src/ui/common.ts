import type { Reply, UiRequest } from "../shared/messages";

export async function call<T>(req: UiRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as Reply<T> | undefined;
  if (!r) throw new Error("No answer from the extension");
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

type Child = Node | string | false | null | undefined;
type Props = Record<string, unknown> & { class?: string };

/** Tiny DOM builder: h("button", { class: "primary", onclick }, "Text"). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function ago(t: number | string | undefined): string {
  if (t == null) return "never";
  const ms = Date.now() - (typeof t === "string" ? Date.parse(t) : t);
  if (ms < 45_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/** Runs `fn` with the button disabled and a busy label; errors land in `onError`. */
export async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<unknown>, onError: (e: string) => void): Promise<void> {
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}
