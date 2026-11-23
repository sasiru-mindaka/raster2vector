export function initializeTheme() {
  const button = document.getElementById('themeToggle');
  const label = document.getElementById('themeLabel');
  if (!button) return;

  let theme = 'light';
  try {
    const saved = localStorage.getItem('raster2vector-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
    else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch { /* Storage may be disabled; the toggle still works for this session. */ }

  const apply = (nextTheme) => {
    theme = nextTheme;
    document.documentElement.dataset.theme = theme;
    const isDark = theme === 'dark';
    button.setAttribute('aria-pressed', String(isDark));
    button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    label.textContent = `${isDark ? 'Light' : 'Dark'} mode`;
    try { localStorage.setItem('raster2vector-theme', theme); } catch { /* Ignore unavailable storage. */ }
  };

  button.addEventListener('click', () => apply(theme === 'dark' ? 'light' : 'dark'));
  apply(theme);
}
