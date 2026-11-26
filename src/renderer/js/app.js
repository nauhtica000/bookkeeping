// App shell: sidebar navigation, hash router, first-run setup.
import { h, s, clear, formatTimestamp } from './dom.js';
import { call, invalidateLookups } from './api.js';
import { showError, showBusy, toast, withBusy } from './ui.js';
import { renderSetup } from './views/setup.js';

const ROUTES = {
  dashboard: { label: 'Dashboard', group: 'Overview', icon: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z', load: () => import('./views/dashboard.js') },
  sales: { label: 'Sales', group: 'Records', icon: 'M3 3h18v4H3zm0 6h18v12H3zm4 3v2h10v-2z', load: () => import('./views/sales.js') },
  expenses: { label: 'Expenses', group: 'Records', icon: 'M6 2h9l5 5v15H6zm8 1v5h5M9 13h8M9 17h8', load: () => import('./views/expenses.js') },
  customers: { label: 'Customers', group: 'Records', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0z', load: () => import('./views/customers.js') },
  tax: { label: 'Sales tax report', group: 'Taxes', icon: 'M4 3h16v18l-4-2-4 2-4-2-4 2zM8 8h8M8 12h8', load: () => import('./views/taxReport.js') },
  setaside: { label: 'Tax set-aside', group: 'Taxes', icon: 'M3 10l9-6 9 6v2H3zm2 4h2v5H5zm6 0h2v5h-2zm6 0h2v5h-2zM3 20h18v2H3z', load: () => import('./views/setAside.js') },
  owner: { label: 'Owner funds', group: 'Taxes', icon: 'M2 7h20v12H2zm10 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', load: () => import('./views/owner.js') },
  import: { label: 'Shopify import', group: 'Data', icon: 'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16', load: () => import('./views/import.js') },
  backup: { label: 'Backup & export', group: 'Data', icon: 'M4 4h16v6H4zm0 10h16v6H4zm3-7h2m-2 10h2', load: () => import('./views/backup.js') },
  trash: { label: 'Trash', group: 'Data', icon: 'M4 6h16M9 6V3h6v3m-9 0l1 15h10l1-15', load: () => import('./views/trash.js') },
  settings: { label: 'Settings', group: 'Data', icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4l-2-1-1-3 1-2-2-2-2 1-3-1-1-2h-2l-1 2-3 1-2-1-2 2 1 2-1 3-2 1v2l2 1 1 3-1 2 2 2 2-1 3 1 1 2h2l1-2 3-1 2 1 2-2-1-2 1-3 2-1z', load: () => import('./views/settings.js') },
};

let appStatus = null;
let renderToken = 0;

export function navigate(route, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const target = `#${route}${q ? `?${q}` : ''}`;
  if (location.hash === target) renderRoute();
  else location.hash = target;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [route, query] = raw.split('?');
  return { route: ROUTES[route] ? route : 'dashboard', params: Object.fromEntries(new URLSearchParams(query || '')) };
}

function navIcon(d) {
  return s('svg', { class: 'nav-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' }, s('path', { d }));
}

export async function refreshSidebar() {
  try {
    appStatus = await call('app.status');
  } catch (e) {
    showError(e);
  }
  let badges = { reviewCount: 0 };
  try {
    badges = await call('badges.get');
  } catch {
    /* sidebar still renders */
  }
  const nav = clear(document.getElementById('sidebar'));
  const { route } = parseHash();
  nav.append(h('div', { class: 'brand' }, h('div', { class: 'brand-name' }, 'MMA Books'), h('div', { class: 'brand-sub' }, 'MMA Milling LLC')));
  let group = null;
  for (const [key, r] of Object.entries(ROUTES)) {
    if (r.group !== group) {
      group = r.group;
      nav.append(h('div', { class: 'nav-group' }, group));
    }
    const badge = key === 'sales' && badges.reviewCount ? h('span', { class: 'badge', title: 'Flagged for review' }, String(badges.reviewCount)) : null;
    nav.append(h('a', { class: ['nav-link', key === route && 'active'], href: `#${key}`, 'aria-current': key === route ? 'page' : null }, navIcon(r.icon), r.label, badge));
  }
  const lb = appStatus?.lastBackup;
  const backupLine = lb
    ? h('div', null, lb.ok ? 'Last backup ' : h('span', { class: 'warn-dot' }, '⚠ Backup problem '), formatTimestamp(lb.at))
    : h('div', null, h('span', { class: 'warn-dot' }, '⚠ '), 'No backup yet');
  nav.append(
    h(
      'div',
      { class: 'sidebar-foot' },
      backupLine,
      appStatus?.backupFolder ? null : h('div', null, h('a', { href: '#backup', style: { color: 'inherit', textDecoration: 'underline' } }, 'Set a backup folder')),
      h('div', { style: { marginTop: '6px' } }, `v${appStatus?.version ?? ''}`),
    ),
  );
}

async function renderRoute() {
  const token = ++renderToken;
  const { route, params } = parseHash();
  const main = document.getElementById('main');
  document.querySelectorAll('.nav-link').forEach((a) => {
    const on = a.getAttribute('href') === `#${route}`;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${ROUTES[route].label} — MMA Books`;
  try {
    const mod = await ROUTES[route].load();
    if (token !== renderToken) return;
    const page = h('div', { class: 'page' });
    await mod.render(page, params, { navigate, refreshSidebar, status: appStatus });
    if (token !== renderToken) return;
    clear(main).append(page);
    main.scrollTop = 0;
  } catch (e) {
    if (token !== renderToken) return;
    clear(main).append(h('div', { class: 'banner error' }, h('span', { class: 'banner-icon' }, '!'), h('div', null, `This screen couldn't load: ${e.message}`)));
    console.error(e);
  }
}

export async function rerender() {
  await renderRoute();
}

async function backupNow() {
  try {
    const res = await withBusy('Backing up…', () => call('app.backupNow'));
    if (res.ok) toast('Backup complete.', { type: 'success' });
    else toast(`Backup had problems: ${res.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}`, { type: 'error', timeout: 12000 });
  } catch (e) {
    showError(e);
    if (/backup folder/i.test(e.message)) navigate('backup');
  }
  refreshSidebar();
}

// A file dropped anywhere other than a drop zone must not navigate the window.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

async function boot() {
  window.addEventListener('hashchange', () => {
    renderRoute();
    refreshSidebar();
  });
  window.mma?.onMenu((action) => {
    if (action === 'backing-up') showBusy('Backing up before closing…');
    if (action === 'backup-now') backupNow();
  });
  try {
    appStatus = await call('app.status');
  } catch (e) {
    showError(e);
    return;
  }
  const shell = document.getElementById('app');
  if (!appStatus.configured) {
    shell.classList.add('no-sidebar');
    renderSetup(document.getElementById('main'), appStatus, async () => {
      shell.classList.remove('no-sidebar');
      invalidateLookups();
      await refreshSidebar();
      navigate('dashboard');
    });
    return;
  }
  await refreshSidebar();
  await renderRoute();
}

boot();
