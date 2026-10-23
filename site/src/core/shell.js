/* Page shell behaviour shared by every page: theme selection, mobile navigation and glossary hints. */
import GLOSSARY from '../data/glossary.json';

const THEME_KEY = 'pet-theme';

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(value) {
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {}
}

function setupTheme() {
  const select = document.getElementById('theme');
  if (!select) return;
  select.value = readTheme();
  applyTheme(select.value);
  // Registered first so controllers that repaint on 'change' read the new colours.
  select.addEventListener('change', () => applyTheme(select.value));
}

function setupMenu() {
  const button = document.getElementById('menuButton'),
    nav = document.getElementById('siteNav');
  if (!button || !nav) return;
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    nav.dataset.open = String(open);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.dataset.open === 'true') {
      button.setAttribute('aria-expanded', 'false');
      nav.dataset.open = 'false';
      button.focus();
    }
  });
}

/* Terms marked <a class="term" data-term="lor"> link to the glossary and show a short definition on
   hover or keyboard focus. Without JavaScript they remain ordinary links. */
function setupGlossary() {
  const terms = document.querySelectorAll('.term[data-term]');
  if (!terms.length) return;
  const tip = document.createElement('div');
  tip.className = 'termtip';
  tip.id = 'termtip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  const show = (el) => {
    const entry = GLOSSARY[el.dataset.term];
    if (!entry) return;
    tip.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = entry.term;
    tip.append(strong, document.createTextNode(' ' + entry.short));
    tip.hidden = false;
    el.setAttribute('aria-describedby', 'termtip');
    const r = el.getBoundingClientRect(),
      width = Math.min(320, window.innerWidth - 32);
    tip.style.width = width + 'px';
    tip.style.left = Math.max(16, Math.min(window.innerWidth - width - 16, r.left)) + window.scrollX + 'px';
    tip.style.top = r.bottom + window.scrollY + 8 + 'px';
  };
  const hide = (el) => {
    tip.hidden = true;
    el?.removeAttribute('aria-describedby');
  };
  for (const el of terms) {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('mouseleave', () => hide(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('blur', () => hide(el));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}

export function setupShell() {
  setupTheme();
  setupMenu();
  setupGlossary();
}
