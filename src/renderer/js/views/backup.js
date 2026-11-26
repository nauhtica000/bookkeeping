import { h, clear, formatTimestamp, formatBytes } from '../dom.js';
import { call, lookups, invalidateLookups } from '../api.js';
import { pageHead, button, toast, showError, withBusy, rangePicker, rangeFor } from '../ui.js';

const exportRange = { preset: 'ytd', from: '', to: '' };

export async function render(page, params, ctx) {
  const L = await lookups();
  const body = h('div');
  const load = async () => {
    const [st, lists] = await Promise.all([call('app.status'), call('app.listBackups')]);
    clear(body).append(renderBody(st, lists, L, load, ctx));
  };
  page.append(pageHead('Backup & export', 'Keep copies of your books somewhere other than this computer, and export CSVs for your accountant.'), body);
  await load();
}

function backupResultLine(lb) {
  if (!lb) return h('div', { class: 'banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', null, 'No backup has been made yet.'));
  const bad = (lb.results || []).filter((r) => !r.ok);
  return h(
    'div',
    { class: ['banner', lb.ok ? 'good' : 'error'] },
    h('span', { class: 'banner-icon' }, lb.ok ? '✓' : '!'),
    h(
      'div',
      null,
      h('div', null, `Last ${lb.kind === 'auto' ? 'automatic' : 'manual'} backup: ${formatTimestamp(lb.at)}${lb.ok ? ' — OK' : ' — had problems'}`),
      bad.map((r) => h('div', { class: 'small' }, `${r.dest}: ${r.error}`)),
    ),
  );
}

function fileTable(files, restore, emptyText) {
  if (!files.length) return h('div', { class: 'empty' }, emptyText);
  return h(
    'table',
    { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Made'), h('th', { class: 'num' }, 'Size'), h('th', null, ''))),
    h(
      'tbody',
      null,
      files.map((f) => h('tr', null, h('td', { class: 'mono' }, f.name), h('td', null, formatTimestamp(f.modified)), h('td', { class: 'num' }, formatBytes(f.size)), h('td', { class: 'actions-cell' }, button('Restore…', () => restore(f.path), { small: true })))),
    ),
  );
}

function renderBody(st, lists, L, reload, ctx) {
  const restore = async (file) => {
    try {
      const r = await withBusy('Restoring…', () => call('app.restoreBackup', file ? { file } : {}));
      if (r.canceled) return;
      invalidateLookups();
      toast(`Restored. Your previous data was saved as ${r.preRestoreFile ? r.preRestoreFile.split(/[\\/]/).pop() : 'a pre-restore copy'}.${r.missingReceipts ? ` ${r.missingReceipts} receipt file(s) are missing from the data folder.` : ''}`, { type: r.missingReceipts ? 'error' : 'success', timeout: 12000 });
      await ctx.refreshSidebar();
      ctx.navigate('dashboard');
    } catch (e) {
      showError(e);
    }
  };

  const folderCard = h(
    'div',
    { class: 'card' },
    h('h2', null, 'Backup folder'),
    st.backupFolder
      ? h('div', { class: 'path-box' }, st.backupFolder)
      : h('div', { class: 'banner' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', null, 'Not set. Choose a network share, NAS, or external drive so a copy survives if this computer fails.')),
    h(
      'div',
      { class: 'row section' },
      button(st.backupFolder ? 'Change…' : 'Choose backup folder…', async () => {
        const r = await call('app.chooseBackupFolder');
        if (!r.canceled) {
          toast('Backup folder saved.', { type: 'success' });
          reload();
          ctx.refreshSidebar();
        }
      }, { primary: !st.backupFolder }),
      st.backupFolder ? button('Stop using it', async () => { await call('app.clearBackupFolder'); reload(); ctx.refreshSidebar(); }) : null,
      st.backupFolder
        ? button('Back up now', async () => {
            const res = await withBusy('Backing up…', () => call('app.backupNow'));
            if (res.ok) toast('Backup complete.', { type: 'success' });
            else toast('Backup had problems — see below.', { type: 'error' });
            reload();
            ctx.refreshSidebar();
          }, { primary: true })
        : null,
    ),
    h('div', { class: 'section' }, backupResultLine(st.lastBackup)),
    h(
      'div',
      { class: 'note-box' },
      'Every time MMA Books closes it makes an automatic backup in the data folder (backups/auto) and, if set, in this folder (auto/). The newest 30 of each are kept. "Back up now" saves to this folder\'s manual/ subfolder and those are kept until you delete them. Receipt files are copied to receipts/ in the backup folder.',
    ),
  );

  const restoreCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Restore'), h('div', { class: 'actions' }, button('Restore from a file…', () => restore(null)))),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Restoring replaces your current books with the backup. Your current data is saved first in backups/pre-restore, so a restore can itself be undone.'),
    h('h3', { class: 'section' }, 'Automatic backups on this computer'),
    h('div', { class: 'table-wrap' }, fileTable(lists.local, restore, 'None yet — one is made each time the app closes.')),
    st.backupFolder ? [h('h3', { class: 'section' }, 'In the backup folder'), h('div', { class: 'table-wrap' }, fileTable([...lists.externalManual, ...lists.externalAuto].sort((a, b) => (a.modified < b.modified ? 1 : -1)), restore, 'No backups in the backup folder yet.'))] : null,
    lists.preRestore.length ? [h('h3', { class: 'section' }, 'Saved before a restore'), h('div', { class: 'table-wrap' }, fileTable(lists.preRestore, restore, ''))] : null,
  );

  const picker = rangePicker({ value: exportRange, today: L.today, label: 'Date range', onChange: (r) => Object.assign(exportRange, r) });
  const doExport = (kind) => async () => {
    const cur = picker.current();
    if (kind === 'taxReport' && (!cur.from || !cur.to)) {
      toast('Choose a date range with a start and end for the tax report.', { type: 'error' });
      return;
    }
    const r = await call('app.exportCsv', { kind, from: cur.from || undefined, to: cur.to || undefined });
    if (!r.canceled) toast(`Saved ${r.path.split(/[\\/]/).pop()}`, { type: 'success', actionLabel: 'Show', onAction: () => call('app.showFile', { path: r.path }) });
  };
  const exportCard = h(
    'div',
    { class: 'card' },
    h('h2', null, 'Export CSV'),
    h('div', { class: 'toolbar' }, picker),
    h('div', { class: 'row' }, button('Export sales', doExport('sales')), button('Export expenses', doExport('expenses')), button('Export sales tax report', doExport('taxReport'))),
    h('p', { class: 'small muted' }, 'CSV files open in Excel. Amounts are plain numbers (refunds and credits are negative).'),
  );

  const dataCard = h(
    'div',
    { class: 'card' },
    h('h2', null, 'Data folder'),
    h('div', { class: 'path-box' }, st.dataFolder),
    h('div', { class: 'row section' }, button('Open data folder', () => call('app.revealDataFolder'))),
    h('p', { class: 'small muted' }, 'Everything lives here: mma-books.db (the database), receipts/, backups/, and exports/. Copying this whole folder (with the app closed) is also a complete backup.'),
  );

  void rangeFor;
  return h('div', null, h('div', { class: 'grid-2' }, folderCard, dataCard), h('div', { class: 'section' }, restoreCard), h('div', { class: 'section' }, exportCard));
}
