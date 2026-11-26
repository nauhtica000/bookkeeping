import { h, clear, money, moneyCell, date, plural, formatTimestamp } from '../dom.js';
import { call } from '../api.js';
import { pageHead, button, toast, showError, withBusy, undoToast } from '../ui.js';
import { NY_COUNTIES, jurisdictionLabel } from '../../../shared/geo.js';

const STATUS = {
  new: ['Will import', 'good'],
  new_refund: ['New refund', 'accent'],
  needs_county: ['Needs county', 'warn'],
  duplicate: ['Already imported', ''],
  in_trash: ['In Trash', ''],
  skipped: ['Skipped', ''],
  error: ['Error', 'danger'],
  excluded: ['Left out', ''],
};

let session = null; // { plan, mapping, decisions }

export async function render(page, params, ctx) {
  const body = h('div');
  page.append(pageHead('Shopify import', 'Import the Orders export CSV from Shopify. Nothing is saved until you click Import.'), body);

  const showStart = async () => {
    session = null;
    const history = await call('import.history');
    clear(body).append(startScreen(history, openFile, showStart, ctx));
  };

  const openFile = async (path) => {
    try {
      const plan = await withBusy('Reading file…', () => call('app.importOpen', path ? { path } : {}));
      if (plan.canceled) return;
      session = { plan, mapping: plan.mapping, decisions: { counties: {}, custom: {}, exclude: {}, includeTrashed: false } };
      await showPreview();
    } catch (e) {
      showError(e);
    }
  };

  const refreshPreview = async () => {
    try {
      session.plan = await call('app.importPreview', { mapping: session.mapping, decisions: session.decisions });
      await showPreview();
    } catch (e) {
      showError(e);
    }
  };

  const showPreview = async () => {
    const el = await previewScreen(session, refreshPreview, commit, cancel);
    clear(body).append(el);
  };

  const cancel = async () => {
    await call('app.importCancel');
    showStart();
  };

  const commit = async () => {
    try {
      const res = await withBusy('Importing…', () => call('app.importCommit', { mapping: session.mapping, decisions: session.decisions }));
      session = null;
      ctx.refreshSidebar();
      clear(body).append(
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'Import complete'),
          h('p', null, `${plural(res.salesCreated, 'sale')} and ${plural(res.refundsCreated, 'refund')} imported. ${res.skipped ? `${plural(res.skipped, 'order')} skipped.` : ''}`),
          res.flagged ? h('div', { class: 'banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', null, `${plural(res.flagged, 'record')} flagged for review — mostly refunds, whose tax split Shopify's export doesn't provide. Check them against Shopify.`)) : null,
          h('div', { class: 'row' }, button('View imported sales', () => ctx.navigate('sales', { batch: res.batchId }), { primary: true }), button('Import another file', showStart)),
        ),
      );
    } catch (e) {
      showError(e);
    }
  };

  if (session) await showPreview();
  else await showStart();
}

function startScreen(history, openFile, reload, ctx) {
  const drop = h('div', { class: 'dropzone', style: { padding: '28px' } }, h('div', null, 'Drop the Shopify CSV here, or'), h('div', { style: { marginTop: '8px' } }, button('Choose CSV file…', () => openFile(), { primary: true })));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) openFile(window.mma.pathForFile(f));
  });
  const hist = history.length
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'Imported'), h('th', null, 'File'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Refunds'), h('th', { class: 'num' }, 'Skipped'), h('th', null, ''), h('th', null, ''))),
          h(
            'tbody',
            null,
            history.map((b) =>
              h(
                'tr',
                null,
                h('td', { class: 'nowrap' }, formatTimestamp(b.created_at)),
                h('td', null, b.file_name),
                h('td', { class: 'num' }, String(b.sales_created)),
                h('td', { class: 'num' }, String(b.refunds_created)),
                h('td', { class: 'num' }, String(b.orders_skipped)),
                h('td', null, b.deleted_at ? h('span', { class: 'badge' }, 'Undone') : null),
                h(
                  'td',
                  { class: 'actions-cell' },
                  b.deleted_at
                    ? button('Restore', async () => {
                        await call('import.restore', { id: b.id });
                        toast('Import restored.', { type: 'success' });
                        reload();
                      }, { small: true })
                    : [
                        button('View sales', () => ctx.navigate('sales', { batch: b.id }), { small: true, ghost: true }),
                        button('Undo import', async () => {
                          const r = await call('import.undo', { id: b.id });
                          undoToast(`Import undone (${plural(r.count, 'record')} moved to the Trash).`, () => call('import.restore', { id: b.id }), reload);
                          reload();
                        }, { small: true, ghost: true }),
                      ],
                ),
              ),
            ),
          ),
        ),
      )
    : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'No imports yet.'));
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'grid-2' },
      h('div', { class: 'card' }, h('h2', null, 'Choose the export file'), drop),
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'Getting the file from Shopify'),
        h(
          'ol',
          { class: 'steps' },
          h('li', null, 'In Shopify admin, open Orders.'),
          h('li', null, 'Filter to the dates you want (or all orders), then click Export.'),
          h('li', null, 'Choose "Plain CSV file" and export; Shopify emails or downloads the file.'),
          h('li', null, 'Import it here. Orders already in your books are skipped automatically, so overlapping exports are fine.'),
        ),
        h('p', { class: 'small muted' }, 'Shopify fees and payouts are not in this export — record Shopify fees as expenses (Fees category).'),
      ),
    ),
    h('div', { class: 'section' }, h('h2', null, 'Import history'), hist),
  );
}

async function previewScreen(s, refresh, commit, cancel) {
  const p = s.plan;
  const parts = [];
  parts.push(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('div', null, h('h2', { style: { margin: 0 } }, p.fileName), h('div', { class: 'muted small' }, `${plural(p.rowsRead, 'row')} · ${plural(p.ordersRead || 0, 'order')}`)), h('div', { class: 'spacer' }), button('Choose a different file', cancel)),
      p.previousImport ? h('div', { class: 'banner section' }, h('span', { class: 'banner-icon' }, 'ℹ'), h('div', null, `This exact file was already imported on ${formatTimestamp(p.previousImport.created_at)}. Orders you already have will be skipped.`)) : null,
    ),
  );

  // Column mapping
  const mapErrors = p.mappingErrors || [];
  const mapTable = h('div', { class: 'form-grid' });
  {
    const fields = await call('import.fields');
    for (const f of fields) {
      const sel = h('select', { 'aria-label': f.label }, [h('option', { value: '' }, '— not in file —'), ...p.headers.map((hd) => h('option', { value: hd }, hd))]);
      sel.value = s.mapping[f.key] || '';
      sel.addEventListener('change', () => {
        s.mapping = { ...s.mapping, [f.key]: sel.value || null };
        refresh();
      });
      mapTable.append(h('div', { class: 'field span-2' }, h('label', null, f.label, f.required ? h('span', { class: 'req' }, '*') : null), sel));
    }
    const mapping = h('details', { class: 'card section', open: mapErrors.length > 0 }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Column mapping', mapErrors.length ? h('span', { class: 'badge danger', style: { marginLeft: '8px' } }, 'needs attention') : h('span', { class: 'muted small', style: { marginLeft: '8px' } }, 'detected automatically — open to change')), h('div', { class: 'section' }, mapTable));
    parts.push(mapping);
    if (mapErrors.length) {
      parts.push(h('div', { class: 'banner error section' }, h('span', { class: 'banner-icon' }, '!'), h('div', null, mapErrors.map((e) => h('div', null, e)))));
      return h('div', null, parts);
    }

    // Counts
    const c = p.counts;
    parts.push(
      h(
        'div',
        { class: 'chips section' },
        Object.entries(STATUS)
          .filter(([k]) => c[k])
          .map(([k, [label]]) => h('span', { class: 'chip' }, `${label}: `, h('strong', null, String(c[k])))),
      ),
    );

    // Counties needed
    if (p.needsCountyZips.length) {
      const rows = p.needsCountyZips.map((z) => {
        const sel = h('select', { 'aria-label': `County for ZIP ${z.zip}` }, [h('option', { value: '' }, 'Choose county…'), ...NY_COUNTIES.map((n) => h('option', { value: n }, n))]);
        const loc = h('input', { type: 'text', placeholder: 'City/locality (optional)', 'aria-label': 'Locality' });
        const apply = button('Apply', () => {
          if (!sel.value) return toast('Choose a county first.', { type: 'error' });
          if (!z.zip) {
            return toast('These orders have no ZIP; enter the county on each sale after importing, or leave them out.', { type: 'error' });
          }
          s.decisions.counties[z.zip] = { county: sel.value, locality: loc.value.trim() };
          refresh();
        }, { small: true, primary: true });
        return h('tr', null, h('td', { class: 'mono' }, z.zip || '(no ZIP)'), h('td', null, z.orders.join(', ')), h('td', null, sel), h('td', null, loc), h('td', null, apply));
      });
      parts.push(
        h(
          'div',
          { class: 'card section' },
          h('h2', null, 'New York orders that need a county'),
          h('p', { class: 'muted small' }, "Shopify's export has no county column. When the county can't be read from Shopify's tax lines, choose it for each ZIP below. Your answer is remembered for future imports."),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'ZIP'), h('th', null, 'Orders'), h('th', null, 'County'), h('th', null, 'Locality'), h('th', null, ''))), h('tbody', null, rows))),
        ),
      );
    }

    // Options
    const trashToggle = h('input', { type: 'checkbox', checked: !!s.decisions.includeTrashed });
    trashToggle.addEventListener('change', () => {
      s.decisions.includeTrashed = trashToggle.checked;
      refresh();
    });
    if (c.in_trash || s.decisions.includeTrashed) parts.push(h('label', { class: 'check section' }, trashToggle, 'Re-import orders that are in the Trash'));

    // Orders
    const tbody = h('tbody');
    for (const o of p.orders) {
      const [label, tone] = STATUS[o.status];
      const includable = ['new', 'needs_county', 'excluded', 'new_refund'].includes(o.status);
      const inc = h('input', { type: 'checkbox', checked: o.status !== 'excluded', disabled: !includable, 'aria-label': `Include ${o.orderNumber}` });
      inc.addEventListener('change', () => {
        if (inc.checked) delete s.decisions.exclude[o.orderNumber];
        else s.decisions.exclude[o.orderNumber] = true;
        refresh();
      });
      const custom = h('input', { type: 'checkbox', checked: !!s.decisions.custom[o.orderNumber], disabled: !['new', 'needs_county', 'excluded'].includes(o.status), 'aria-label': `Custom job ${o.orderNumber}` });
      custom.addEventListener('change', () => {
        if (custom.checked) s.decisions.custom[o.orderNumber] = true;
        else delete s.decisions.custom[o.orderNumber];
        refresh();
      });
      const notes = [...(o.reasons || []), ...(o.warnings || [])];
      if (o.refund) notes.push(`Refund ${money(o.refund.amount)} on ${date(o.refund.date)} (split estimated)`);
      const j = o.jurisdiction;
      tbody.append(
        h(
          'tr',
          null,
          h('td', null, includable ? inc : null),
          h('td', { class: 'nowrap' }, o.orderNumber),
          h('td', { class: 'nowrap' }, o.date ? date(o.date) : '—'),
          h('td', null, o.customerName || h('span', { class: 'faint' }, '—')),
          o.subtotal === null ? h('td') : moneyCell(o.subtotal),
          o.shipping === null ? h('td') : moneyCell(o.shipping),
          o.tax === null ? h('td') : moneyCell(o.tax),
          o.total === null ? h('td') : moneyCell(o.total),
          h('td', { class: 'small', title: j?.source ? `From ${j.source}` : '' }, j ? jurisdictionLabel(j.state, j.county, j.locality) : '—'),
          h('td', null, custom),
          h('td', null, h('span', { class: ['badge', tone] }, label)),
          h('td', { class: 'small wrap muted', style: { maxWidth: '320px' } }, notes.join(' ')),
        ),
      );
    }
    parts.push(
      h(
        'div',
        { class: 'section table-wrap' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'Include'), h('th', null, 'Order'), h('th', null, 'Date'), h('th', null, 'Customer'), ['Subtotal', 'Shipping', 'Tax', 'Total'].map((t) => h('th', { class: 'num' }, t)), h('th', null, 'Ship to'), h('th', null, 'Custom'), h('th', null, 'Status'), h('th', null, 'Notes'))),
          tbody,
        ),
      ),
    );
    const n = (c.new || 0) + (c.new_refund || 0);
    const go = button(n ? `Import ${plural(n, 'order')}` : 'Nothing to import', commit, { primary: true });
    go.disabled = !p.canCommit;
    parts.push(
      h(
        'div',
        { class: 'row section' },
        go,
        button('Cancel', cancel),
        c.needs_county ? h('span', { class: 'muted small' }, `Choose a county for ${plural(c.needs_county, 'order')} above (or untick them) to continue.`) : null,
      ),
    );
    return h('div', null, parts);
  }
}
