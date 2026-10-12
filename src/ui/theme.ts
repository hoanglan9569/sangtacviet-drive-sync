/**
 * Light / dark / system theme. chrome.storage.local is the source of truth
 * (it survives restarts and syncs open pages); localStorage mirrors it so
 * theme-init.ts can apply it before the first paint.
 */
import { icon } from "./icons";

export type Theme = "system" | "light" | "dark";

const THEME_KEY = "theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function apply(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the page still follows chrome.storage.
  }
}

/** The theme actually shown: "system" resolved against the OS setting. */
export function shown(theme: Theme): "light" | "dark" {
  return theme === "system" ? (darkQuery.matches ? "dark" : "light") : theme;
}

export async function getTheme(): Promise<Theme> {
  return ((await chrome.storage.local.get(THEME_KEY))[THEME_KEY] as Theme | undefined) ?? "system";
}

export async function setTheme(theme: Theme): Promise<void> {
  apply(theme);
  await chrome.storage.local.set({ [THEME_KEY]: theme });
}

/** Applies the stored theme and follows changes from other pages and the OS. */
export function watchTheme(onChange?: (theme: Theme) => void): void {
  let current: Theme = "system";
  const update = (theme: Theme) => {
    current = theme;
    apply(theme);
    onChange?.(theme);
  };
  void getTheme().then(update);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && THEME_KEY in changes) update((changes[THEME_KEY]!.newValue as Theme | undefined) ?? "system");
  });
  darkQuery.addEventListener("change", () => onChange?.(current));
}

/** Applies the stored theme and wires `button` as a light/dark toggle showing the mode it switches to. */
export function themeToggle(button: HTMLElement): void {
  let current: Theme = "system";
  watchTheme((theme) => {
    current = theme;
    const dark = shown(theme) === "dark";
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren(icon(dark ? "sun" : "moon"));
  });
  button.addEventListener("click", () => void setTheme(shown(current) === "dark" ? "light" : "dark"));
}
