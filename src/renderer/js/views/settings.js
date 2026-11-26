import { h, clear } from '../dom.js';
import { call, lookups, invalidateLookups } from '../api.js';
import { pageHead, button, field, formValues, showFormError, toast, undoToast, showError, confirmDialog } from '../ui.js';
import { formatBasisPoints } from '../../../shared/money.js';
import { US_STATES, NY_COUNTIES } from '../../../shared/geo.js';

export async function render(page, params, ctx) {
  const body = h('div');
  const load = async () => {
    invalidateLookups();
    const L = await lookups({ refresh: true });
    const st = await call('app.status');
    clear(body).append(businessCard(L, load), categoriesCard(L, load), paymentCard(L, load), dataCard(st, ctx));
  };
  page.append(pageHead('Settings'), body);
  await load();
}

function businessCard(L, reload) {
  const s = L.settings;
  const form = h('form', { class: 'form-grid', onsubmit: (e) => e.preventDefault() });
  const stateF = field({ label: 'Business state', name: 'default_state', type: 'select', value: s.default_state, options: US_STATES.map(([c, n]) => ({ value: c, label: n })) });
  const countyBox = h('div', { class: 'span-2' });
  const renderCounty = (val) => {
    clear(countyBox).append(
      stateF.input.value === 'NY'
        ? field({ label: 'Business county', name: 'default_county', type: 'select', value: val, span: 6, options: NY_COUNTIES.map((c) => ({ value: c, label: c })) })
        : field({ label: 'Business county', name: 'default_county', value: val, span: 6 }),
    );
  };
  stateF.input.addEventListener('change', () => renderCounty(''));
  renderCounty(s.default_county);
  form.append(
    field({ label: 'Business name', name: 'business_name', value: s.business_name, required: true, span: 4 }),
    field({ label: 'Income-tax set-aside %', name: 'set_aside_percent', value: formatBasisPoints(s.set_aside_bp), required: true, help: 'Share of net profit to save for income tax' }),
    stateF,
    countyBox,
    field({ label: 'Business city / locality', name: 'default_locality', value: s.default_locality, help: 'Only if it has its own tax rate' }),
    h('div', { class: 'span-6 small muted' }, 'The business location is used for local pickups and Shopify orders without a ship-to address.'),
  );
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Business'), h('div', { class: 'actions' }, button('Save', async () => {
      try {
        await call('settings.update', formValues(form));
      } catch (e) {
        showFormError(form, e);
        return;
      }
      toast('Settings saved.', { type: 'success', timeout: 2000 });
      reload();
    }, { primary: true }))),
    form,
  );
}

function editableRow({ item, kind, reload, fields }) {
  const inputs = fields.map((f) => {
    if (f.type === 'checkbox') {
      const c = h('input', { type: 'checkbox', checked: !!item[f.key], 'aria-label': f.label });
      return { key: f.key, el: h('label', { class: 'check' }, c, f.short || ''), get: () => c.checked, input: c };
    }
    const i = h('input', { type: 'text', value: item[f.key] ?? '', 'aria-label': f.label });
    return { key: f.key, el: i, get: () => i.value, input: i };
  });
  const save = async () => {
    const values = { id: item.id, active: item.active };
    for (const i of inputs) values[i.key] = i.get();
    try {
      await call(`${kind}.save`, values);
      toast('Saved.', { type: 'success', timeout: 1500 });
      reload();
    } catch (e) {
      showError(e);
    }
  };
  inputs.forEach((i) => i.input.addEventListener('change', save));
  const toggleActive = button(item.active ? 'Archive' : 'Unarchive', async () => {
    const values = { id: item.id, active: !item.active };
    for (const i of inputs) values[i.key] = i.get();
    await call(`${kind}.save`, values);
    reload();
  }, { small: true, ghost: true, title: item.active ? 'Hide from new entries (keeps existing records)' : 'Show in new entries again' });
  const del = button('Delete', async () => {
    await call(`${kind}.delete`, { id: item.id });
    undoToast(`"${item.name}" deleted.`, () => call('trash.restore', { type: kind === 'categories' ? 'category' : 'paymentMethod', id: item.id }), reload);
    reload();
  }, { small: true, ghost: true });
  return h(
    'tr',
    { class: item.active ? null : 'muted' },
    inputs.map((i) => h('td', null, i.el)),
    h('td', { class: 'num' }, String(item.expense_count + (item.sale_count || 0))),
    h(
      'td',
      { class: 'actions-cell' },
      button('↑', async () => { await call(`${kind}.move`, { id: item.id, direction: -1 }); reload(); }, { small: true, ghost: true, title: 'Move up' }),
      button('↓', async () => { await call(`${kind}.move`, { id: item.id, direction: 1 }); reload(); }, { small: true, ghost: true, title: 'Move down' }),
      toggleActive,
      del,
    ),
  );
}

function categoriesCard(L, reload) {
  const newName = h('input', { type: 'text', placeholder: 'New category name', 'aria-label': 'New category name' });
  const newLine = h('input', { type: 'text', placeholder: 'Schedule C line (e.g. Line 21 — Repairs and maintenance)', 'aria-label': 'Schedule C line' });
  return h(
    'div',
    { class: 'card' },
    h('h2', null, 'Expense categories'),
    h(
      'div',
      { class: 'banner info' },
      h('span', { class: 'banner-icon' }, 'ℹ'),
      h(
        'div',
        null,
        h('div', null, 'The Schedule C lines below are starting suggestions for a single-member LLC filing Schedule C with Form 1040, and you can edit them.'),
        h('div', null, h('strong', null, 'A multi-member LLC files Form 1065 (partnership return) instead, which uses different lines. '), 'Either way, have your CPA confirm the mapping before you rely on it at tax time.'),
      ),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Schedule C line'), h('th', { class: 'num' }, 'Used'), h('th', null, ''))),
        h(
          'tbody',
          null,
          L.categories.map((c) => editableRow({ item: c, kind: 'categories', reload, fields: [{ key: 'name', label: 'Category name' }, { key: 'schedule_c_line', label: 'Schedule C line' }] })),
          h('tr', null, h('td', null, newName), h('td', null, newLine), h('td'), h('td', { class: 'actions-cell' }, button('Add', async () => {
            await call('categories.save', { name: newName.value, schedule_c_line: newLine.value });
            toast('Category added.', { type: 'success', timeout: 1500 });
            reload();
          }, { small: true, primary: true }))),
        ),
      ),
    ),
    h('p', { class: 'small muted' }, 'Archived categories stay on old expenses but disappear from new ones. A category can only be deleted while no expenses use it.'),
  );
}

function paymentCard(L, reload) {
  const newName = h('input', { type: 'text', placeholder: 'New payment method', 'aria-label': 'New payment method' });
  const newOwner = h('input', { type: 'checkbox', 'aria-label': 'Owner funds' });
  return h(
    'div',
    { class: 'card' },
    h('h2', null, 'Payment methods'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Tick "Owner funds" for anything that is your own money (personal card, personal account). Expenses paid that way are tracked as owed to you.'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Owner funds'), h('th', { class: 'num' }, 'Used'), h('th', null, ''))),
        h(
          'tbody',
          null,
          L.paymentMethods.map((p) => editableRow({ item: p, kind: 'paymentMethods', reload, fields: [{ key: 'name', label: 'Payment method name' }, { key: 'is_owner_funds', label: 'Owner funds', type: 'checkbox', short: 'Owner funds' }] })),
          h('tr', null, h('td', null, newName), h('td', null, h('label', { class: 'check' }, newOwner, 'Owner funds')), h('td'), h('td', { class: 'actions-cell' }, button('Add', async () => {
            await call('paymentMethods.save', { name: newName.value, is_owner_funds: newOwner.checked });
            toast('Payment method added.', { type: 'success', timeout: 1500 });
            reload();
          }, { small: true, primary: true }))),
        ),
      ),
    ),
  );
}

function dataCard(st, ctx) {
  return h(
    'div',
    { class: 'card' },
    h('h2', null, 'Data folder'),
    h('div', { class: 'path-box' }, st.dataFolder),
    st.dataFolderIsNetwork ? h('div', { class: 'banner section' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', null, 'The data folder is on a network location. Keeping the database on a local drive is safer; use the network share as the backup folder instead.')) : null,
    h(
      'div',
      { class: 'row section' },
      button('Open data folder', () => call('app.revealDataFolder')),
      button('Switch to another data folder…', async () => {
        const r = await call('app.chooseDataFolder');
        if (r.canceled) return;
        const ok = await confirmDialog({
          title: 'Switch data folder',
          message: r.hasExisting
            ? `Open the books in\n${r.path}?\n\nYour current books are backed up first and stay where they are.`
            : `Create a new, empty set of books in\n${r.path}?\n\nYour current books are backed up first and stay where they are.`,
          confirmLabel: r.hasExisting ? 'Open' : 'Create',
        });
        if (!ok) return;
        await call('app.openDataFolder', { path: r.path, create: !r.hasExisting });
        invalidateLookups();
        await ctx.refreshSidebar();
        ctx.navigate('dashboard');
      }),
    ),
    h('p', { class: 'small muted' }, `App settings (which folder to open) are stored in ${st.userData}.`),
  );
}
