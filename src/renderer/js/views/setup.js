// First run: choose (or create) the data folder.
import { h, clear, add } from '../dom.js';
import { call } from '../api.js';
import { button, showError } from '../ui.js';

export function renderSetup(main, status, onReady) {
  const chosen = { path: null, info: null };
  const detail = h('div');
  const err = status.openError
    ? h(
        'div',
        { class: 'banner error' },
        h('span', { class: 'banner-icon' }, '!'),
        h('div', null, h('div', null, `Couldn't open your data folder${status.lastFolder ? ` (${status.lastFolder})` : ''}:`), h('div', null, status.openError), h('div', null, 'If it is on a drive that is not connected, connect it and restart MMA Books. Otherwise choose the folder again below.')),
      )
    : null;

  const showChoice = () => {
    clear(detail);
    if (!chosen.info) return;
    const i = chosen.info;
    add(detail,
      h('div', { class: 'section' }, h('div', { class: 'label muted small' }, 'Selected folder'), h('div', { class: 'path-box' }, i.path)),
      !i.writable ? h('div', { class: 'banner error section' }, h('span', { class: 'banner-icon' }, '!'), h('div', null, "MMA Books can't write to this folder. Choose another one.")) : null,
      i.isNetwork
        ? h('div', { class: 'banner section' }, h('span', { class: 'banner-icon' }, '⚠'), h('div', null, 'This looks like a network location. The database itself should live on this computer\'s own drive — SQLite on a network share can be damaged if the connection drops. Put your backups on the network share instead (you can choose a backup folder after setup).'))
        : null,
      i.hasExisting
        ? h('p', null, 'This folder already contains MMA Books records. They will be opened as they are.')
        : h('p', null, 'A new, empty set of books will be created here. Receipts and automatic backups are stored inside this folder too.'),
      h(
        'div',
        { class: 'row section' },
        button(
          i.hasExisting ? 'Open these books' : 'Create books here',
          async () => {
            try {
              await call('app.openDataFolder', { path: i.path, create: !i.hasExisting });
              onReady();
            } catch (e) {
              showError(e);
            }
          },
          { primary: true },
        ),
        button('Choose a different folder', pick),
      ),
    );
    if (!i.writable) detail.querySelector('.btn.primary').disabled = true;
  };

  async function pick() {
    const r = await call('app.chooseDataFolder');
    if (r.canceled) return;
    chosen.info = r;
    showChoice();
  }

  clear(main).append(
    h(
      'div',
      { class: 'setup' },
      err,
      h(
        'div',
        { class: 'card' },
        h('h1', null, 'Welcome to MMA Books'),
        h('p', { class: 'muted' }, 'Bookkeeping for MMA Milling LLC. Everything stays on this computer — there are no accounts, subscriptions, or cloud services.'),
        h(
          'ol',
          { class: 'steps section' },
          h('li', null, 'Choose a folder for your books (for example Documents\\MMA Books). One database file, your receipts, and automatic backups live there.'),
          h('li', null, 'Then set a backup folder — a network share or external drive — under Backup & export.'),
        ),
        h('div', { class: 'row section' }, button('Choose data folder…', pick, { primary: true })),
        detail,
      ),
    ),
  );
}
