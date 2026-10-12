// Loaded as a classic, render-blocking script in <head> so the saved theme is
// applied before the first paint (no light flash in dark mode).
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Fall back to the system theme.
}

export {};
