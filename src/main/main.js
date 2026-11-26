// Electron main process: owns the database, the window, dialogs, and files.
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, DB_FILE_NAME } from '../core/db.js';
import { createBooks } from '../core/books.js';
import { serializeError, ValidationError } from '../core/errors.js';
import { runBackup, listBackupFiles, restoreDatabaseFile, missingReceiptFiles } from '../core/backup.js';
import { RECEIPT_TYPES } from '../core/expenses.js';
import { readConfig, writeConfig } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const ORIGIN = 'app://bookkeeping';
const SERVED_ROOTS = [path.join(SRC, 'renderer'), path.join(SRC, 'shared')];
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

// Lets automated UI tests run against a throwaway profile.
if (process.env.MMA_BOOKS_USER_DATA) app.setPath('userData', process.env.MMA_BOOKS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const state = {
  db: null,
  books: null,
  dataDir: null,
  win: null,
  quitting: false,
  importSession: null,
  exportedFiles: new Set(),
};

// ---------------- Data folder ----------------

function isNetworkPath(p) {
  return /^\\\\/.test(p) || /^\/\//.test(p);
}

function closeDb() {
  try {
    state.db?.close();
  } catch (e) {
    console.error('Error closing database', e);
  }
  state.db = null;
  state.books = null;
}

function openDataFolder(folder, { create = false } = {}) {
  if (!folder || typeof folder !== 'string') throw new ValidationError('Choose a folder first.');
  const dir = path.resolve(folder);
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ValidationError(`Folder not found: ${dir}`);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new ValidationError(`MMA Books can't write to ${dir}. Choose a folder you have permission to change.`);
  }
  const dbPath = path.join(dir, DB_FILE_NAME);
  if (!fs.existsSync(dbPath) && !create) {
    throw new ValidationError(`There are no MMA Books records in ${dir}.`);
  }
  const db = openDatabase(dbPath); // creates + migrates if new; refuses foreign files
  closeDb();
  for (const sub of ['receipts', 'backups', 'exports']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  state.db = db;
  state.dataDir = dir;
  state.books = createBooks({ db, dataDir: dir });
  writeConfig(app.getPath('userData'), { ...readConfig(app.getPath('userData')), dataFolder: dir });
  return status();
}

function backupFolder() {
  return state.books ? state.books.internal.getSetting('backup_folder') || '' : '';
}

function lastBackup() {
  if (!state.books) return null;
  try {
    return JSON.parse(state.books.internal.getSetting('last_backup') || 'null');
  } catch {
    return null;
  }
}

function saveBackupStatus(res) {
  if (!state.books) return;
  try {
    state.books.internal.setSetting('last_backup', JSON.stringify(res));
  } catch (e) {
    console.error('Could not save backup status', e);
  }
}

function status() {
  return {
    configured: !!state.db,
    dataFolder: state.dataDir,
    dbPath: state.dataDir ? path.join(state.dataDir, DB_FILE_NAME) : null,
    dataFolderIsNetwork: state.dataDir ? isNetworkPath(state.dataDir) : false,
    backupFolder: backupFolder(),
    lastBackup: lastBackup(),
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
  };
}

// ---------------- Main-process actions callable from the UI ----------------

const filtersFor = {
  receipts: [{ name: 'Receipts (PDF or image)', extensions: Object.keys(RECEIPT_TYPES).map((e) => e.slice(1)) }],
  csv: [{ name: 'CSV files', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }],
  db: [{ name: 'MMA Books backup', extensions: ['db'] }],
};

function requireBooks() {
  if (!state.books) throw new ValidationError('No data folder is open yet.');
  return state.books;
}

function buildPlan(args = {}) {
  const books = requireBooks();
  if (!state.importSession) throw new ValidationError('Choose a CSV file to import first.');
  return books.internal.buildImportPlan(state.importSession.text, {
    mapping: args.mapping || null,
    decisions: args.decisions || {},
    fileName: state.importSession.fileName,
  });
}

const appMethods = {
  'app.status': () => status(),

  'app.chooseDataFolder': async () => {
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Choose a folder for your MMA Books data',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('documents'),
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const dir = r.filePaths[0];
    let writable = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      path: dir,
      hasExisting: fs.existsSync(path.join(dir, DB_FILE_NAME)),
      isNetwork: isNetworkPath(dir),
      writable,
    };
  },

  'app.openDataFolder': async ({ path: dir, create }) => {
    if (state.db && path.resolve(dir) !== state.dataDir) {
      // Switching folders: snapshot the current books first.
      const res = await runBackup(state.db, state.dataDir, { kind: 'auto', externalFolder: backupFolder(), timeoutMs: 30000 });
      saveBackupStatus(res);
    }
    return openDataFolder(dir, { create: !!create });
  },

  'app.revealDataFolder': async () => {
    requireBooks();
    const err = await shell.openPath(state.dataDir);
    if (err) throw new Error(err);
  },

  'app.chooseBackupFolder': async () => {
    const books = requireBooks();
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Choose a backup folder (a network share or external drive is best)',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: backupFolder() || app.getPath('documents'),
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const dir = path.resolve(r.filePaths[0]);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new ValidationError(`MMA Books can't write to ${dir}.`);
    }
    if (dir === state.dataDir || dir.startsWith(state.dataDir + path.sep)) {
      throw new ValidationError('Choose a folder outside the data folder — ideally on another drive or a network share — so a backup survives a disk failure.');
    }
    books.internal.setSetting('backup_folder', dir);
    return status();
  },

  'app.clearBackupFolder': () => {
    requireBooks().internal.setSetting('backup_folder', '');
    return status();
  },

  'app.backupNow': async () => {
    requireBooks();
    const folder = backupFolder();
    if (!folder) throw new ValidationError('Choose a backup folder first.');
    const res = await runBackup(state.db, state.dataDir, { kind: 'manual', externalFolder: folder, timeoutMs: 120000 });
    saveBackupStatus(res);
    return res;
  },

  'app.listBackups': () => {
    requireBooks();
    const ext = backupFolder();
    return {
      local: listBackupFiles(path.join(state.dataDir, 'backups', 'auto')),
      preRestore: listBackupFiles(path.join(state.dataDir, 'backups', 'pre-restore')),
      externalAuto: ext ? safeList(path.join(ext, 'auto')) : [],
      externalManual: ext ? safeList(path.join(ext, 'manual')) : [],
    };
  },

  'app.restoreBackup': async ({ file } = {}) => {
    requireBooks();
    let backupFile = file;
    if (!backupFile) {
      const r = await dialog.showOpenDialog(state.win, {
        title: 'Choose a backup to restore',
        properties: ['openFile'],
        filters: filtersFor.db,
        defaultPath: backupFolder() || path.join(state.dataDir, 'backups'),
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      backupFile = r.filePaths[0];
    }
    const confirm = await dialog.showMessageBox(state.win, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore backup',
      message: `Replace your current books with this backup?\n\n${path.basename(backupFile)}`,
      detail: 'Anything entered after this backup was made will no longer appear. A copy of your current data is saved first (in backups/pre-restore) so you can undo this.',
    });
    if (confirm.response !== 0) return { canceled: true };
    const dbPath = path.join(state.dataDir, DB_FILE_NAME);
    const dataDir = state.dataDir;
    closeDb();
    let result;
    try {
      result = await restoreDatabaseFile({ dbPath, dataDir, backupFile });
    } finally {
      openDataFolder(dataDir); // reopen whichever database is now in place
    }
    const missing = missingReceiptFiles(state.db, state.dataDir);
    return { ...result, restoredFrom: backupFile, missingReceipts: missing.length };
  },

  'app.pickReceiptFiles': async () => {
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Attach receipts',
      properties: ['openFile', 'multiSelections'],
      filters: filtersFor.receipts,
    });
    return r.canceled ? [] : r.filePaths;
  },

  'app.openReceipt': async ({ id }) => {
    const p = requireBooks().api['receipts.path']({ id });
    const err = await shell.openPath(p);
    if (err) throw new Error(`Couldn't open the receipt: ${err}`);
  },

  'app.showReceipt': ({ id }) => {
    shell.showItemInFolder(requireBooks().api['receipts.path']({ id }));
  },

  'app.importOpen': async ({ path: given } = {}) => {
    requireBooks();
    let file = given;
    if (!file) {
      const r = await dialog.showOpenDialog(state.win, {
        title: 'Choose the Shopify orders export (CSV)',
        properties: ['openFile'],
        filters: filtersFor.csv,
        defaultPath: app.getPath('downloads'),
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      file = r.filePaths[0];
    }
    const st = fs.statSync(file);
    if (st.size > MAX_IMPORT_BYTES) throw new ValidationError('That file is larger than 100 MB.');
    const buf = fs.readFileSync(file);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (text.includes('\u0000')) throw new ValidationError("That doesn't look like a CSV text file.");
    state.importSession = { text, fileName: path.basename(file) };
    return buildPlan({});
  },

  'app.importPreview': (args) => buildPlan(args),

  'app.importCommit': (args) => {
    const plan = buildPlan(args);
    const res = requireBooks().internal.commitImportPlan(plan);
    state.importSession = null;
    return res;
  },

  'app.importCancel': () => {
    state.importSession = null;
  },

  'app.exportCsv': async ({ kind, from, to }) => {
    const books = requireBooks();
    const makers = {
      sales: () => books.internal.salesCsv({ from, to }),
      expenses: () => books.internal.expensesCsv({ from, to }),
      taxReport: () => books.internal.taxReportCsv({ from, to }),
    };
    if (!makers[kind]) throw new ValidationError('Unknown export.');
    const csv = makers[kind]();
    const label = { sales: 'sales', expenses: 'expenses', taxReport: 'sales-tax-report' }[kind];
    const span = from || to ? `_${from || 'start'}_to_${to || 'today'}` : '_all';
    const exportsDir = path.join(state.dataDir, 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const r = await dialog.showSaveDialog(state.win, {
      title: 'Save CSV export',
      defaultPath: path.join(exportsDir, `MMA-Milling_${label}${span}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, csv, 'utf8');
    state.exportedFiles.add(r.filePath);
    return { path: r.filePath };
  },

  'app.showFile': ({ path: p }) => {
    if (!state.exportedFiles.has(p)) throw new ValidationError('Unknown file.');
    shell.showItemInFolder(p);
  },

  'app.print': () => {
    state.win?.webContents.print({ printBackground: false });
  },
};

function safeList(dir) {
  try {
    return listBackupFiles(dir);
  } catch {
    return [];
  }
}

const EXPECTED_ERRORS = new Set(['ValidationError', 'NotFoundError', 'ConflictError', 'MoneyError', 'CsvError']);

ipcMain.handle('mma:call', async (event, method, args) => {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.startsWith(`${ORIGIN}/`)) {
    return { ok: false, error: { name: 'Error', message: 'Request from an untrusted page was blocked.' } };
  }
  try {
    if (typeof method !== 'string') throw new ValidationError('Invalid request.');
    if (Object.hasOwn(appMethods, method)) return { ok: true, data: (await appMethods[method](args ?? {})) ?? null };
    const books = requireBooks();
    if (!Object.hasOwn(books.api, method)) throw new ValidationError(`Unknown action: ${method}`);
    return { ok: true, data: (await books.api[method](args ?? {})) ?? null };
  } catch (e) {
    if (!EXPECTED_ERRORS.has(e?.name)) console.error(`Error in ${method}:`, e);
    return { ok: false, error: serializeError(e) };
  }
});

// ---------------- Window, protocol, menu ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function serveAppFile(request) {
  const url = new URL(request.url);
  if (url.host !== 'bookkeeping') return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/renderer/index.html';
  const abs = path.normalize(path.join(SRC, rel));
  if (!SERVED_ROOTS.some((root) => abs.startsWith(root + path.sep))) return new Response('Not found', { status: 404 });
  try {
    const data = await fs.promises.readFile(abs);
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    return new Response(data, { headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function sendMenu(action) {
  state.win?.webContents.send('mma:menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Back Up Now', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendMenu('backup-now') },
        { label: 'Open Data Folder', click: () => state.dataDir && shell.openPath(state.dataDir) },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => state.win?.webContents.print({ printBackground: false }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    title: 'MMA Books',
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  state.win = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  // Closing the window quits the app (which runs the automatic backup first).
  win.on('close', (e) => {
    if (!state.quitting && state.db) {
      e.preventDefault();
      app.quit();
    }
  });
  win.on('closed', () => {
    state.win = null;
  });
  win.loadURL(`${ORIGIN}/renderer/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.win) {
      if (state.win.isMinimized()) state.win.restore();
      state.win.focus();
    }
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    protocol.handle('app', serveAppFile);
    buildMenu();
    const cfg = readConfig(app.getPath('userData'));
    if (cfg.dataFolder) {
      try {
        openDataFolder(cfg.dataFolder);
      } catch (e) {
        // The renderer shows the setup screen with this message.
        state.openError = e.message;
        console.error('Could not open data folder', e);
      }
    }
    appMethods['app.status'] = () => ({ ...status(), openError: state.db ? null : state.openError || null, lastFolder: cfg.dataFolder || null });
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  // Automatic backup on close: local copy (keep 30) + backup folder if set.
  app.on('before-quit', (e) => {
    if (state.quitting || !state.db) return;
    e.preventDefault();
    state.quitting = true;
    sendMenu('backing-up');
    (async () => {
      try {
        const res = await runBackup(state.db, state.dataDir, { kind: 'auto', externalFolder: backupFolder(), timeoutMs: 30000 });
        saveBackupStatus(res);
      } catch (err) {
        console.error('Automatic backup failed', err);
        saveBackupStatus({ at: new Date().toISOString(), kind: 'auto', ok: false, results: [{ dest: state.dataDir, ok: false, error: err.message }] });
      } finally {
        closeDb();
        app.quit();
      }
    })();
  });
}
