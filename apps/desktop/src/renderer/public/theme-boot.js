// Puts the saved theme on the page before the app's modules load, so the window
// never shows the wrong one first. A plain script, as the page's security policy
// allows no inline one (T3 Code inlines it in apps/web/index.html, MIT). It
// repeats src/lib/theme.ts; theme.test.ts checks the two agree.
(() => {
  let theme = "dark";
  try {
    const saved = localStorage.getItem("chiefbot.theme");
    if (saved === "light" || saved === "system") theme = saved;
  } catch {
    // No storage: keep Dark.
  }
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  // Until styles.css loads; applyTheme removes it.
  document.documentElement.style.backgroundColor = dark ? "#0a0a0a" : "#fcfcfc";
})();
