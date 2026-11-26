# MMA Books

Local-first bookkeeping for **MMA Milling LLC** — custom marine CNC parts, sold through Shopify and direct custom jobs, Suffolk County, NY.

- Single user, works fully offline. No accounts, subscriptions, or cloud services; the app never makes a network request.
- All records live in **one SQLite file** in a folder you choose, alongside your receipt files and automatic backups.
- Money is stored as **integer cents** — never floating point. US dollars only.
- Nothing is ever hard-deleted from the app: deleting moves a record to the **Trash** (with an immediate **Undo**), and every record carries created/updated timestamps.

---

## Installing

### On the Windows PC that will run it

1. Build the installer (one time, see *Building from source* below) or copy `MMA Books Setup 1.0.0.exe` from whoever built it.
2. Run `MMA Books Setup 1.0.0.exe`. It installs for your Windows user (no admin needed) and adds a desktop shortcut.
3. Start **MMA Books**. On first launch it asks for a **data folder** — for example `Documents\MMA Books`. Choose a folder on this computer's own drive (not a network share; see *Backups* for why).
4. Go to **Backup & export → Choose backup folder…** and pick a network share, NAS folder, or external drive.

The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

### Building from source

Requires **Node.js 22 or newer** (https://nodejs.org) on the machine doing the build.

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

To build the Windows installer, run this **on Windows** (it produces `dist\MMA Books Setup 1.0.0.exe`):

```bash
npm run dist:win
```

`npm run dist:mac` and `npm run dist:linux` build for macOS and Linux the same way, each on its own OS. Building the Windows installer on Linux/macOS needs a working Wine install; building on Windows needs nothing extra.

---

## Where your data lives

Everything for the business is in the data folder you chose:

```
<data folder>\
  mma-books.db            the database (all sales, expenses, settings…)
  receipts\2026\          receipt files, copied in when you attach them
  backups\auto\           automatic backups made each time the app closes (newest 30 kept)
  backups\pre-restore\    a copy of your data saved just before any restore
  exports\                default location for CSV exports
```

Receipts are stored by **relative path** (e.g. `receipts/2026/2026-10-02_acme-plastics_3f9a1c2b.pdf`), so the whole folder can be moved or restored as a unit. Attached files are copied, verified, and never modified.

The only thing stored outside the data folder is a tiny app setting that remembers *which* data folder to open:

- Windows: `%APPDATA%\MMA Books\config.json`
- macOS: `~/Library/Application Support/MMA Books/config.json`
- Linux: `~/.config/MMA Books/config.json`

**Settings → Switch to another data folder…** opens or creates books in another folder (your current books are backed up first and left where they are).

---

## Backups

| What | When | Where | Kept |
|---|---|---|---|
| Automatic backup | Every time the app closes | `<data folder>\backups\auto\` | newest 30 |
| Automatic backup (copy) | Every time the app closes, if a backup folder is set | `<backup folder>\auto\` | newest 30 |
| Manual backup | **Backup & export → Back up now** (or File → Back Up Now, Ctrl+Shift+B) | `<backup folder>\manual\` | until you delete them |
| Receipt files | With every backup to the backup folder | `<backup folder>\receipts\` | only ever added to |

- Backups use SQLite's online backup API, so they're consistent even while the app is open, and each copy is integrity-checked before it's kept. Files are written as `*.partial` and renamed when complete, so an interrupted copy never looks like a good backup.
- If the backup folder can't be reached (share offline, drive unplugged), the local backup still happens, and the problem is shown on the dashboard and in the sidebar instead of being silently skipped.
- Put the **backup folder** on the network share — not the data folder. SQLite databases can be damaged if a network connection drops mid-write; a backup copy on the share has no such risk.

### Restoring

In the app: **Backup & export → Restore** lists the automatic and manual backups; click **Restore…** next to one, or **Restore from a file…** to pick any `.db` backup. Before replacing anything the app saves your current database to `backups\pre-restore\`, so a restore can itself be undone the same way. Missing receipt files are copied back from the backup folder's `receipts\` mirror.

By hand (for example, onto a new computer):

1. Install MMA Books and close it.
2. Create a data folder and copy a backup `.db` file into it, renamed to `mma-books.db`.
3. Copy the backup folder's `receipts\` folder into the data folder.
4. Start MMA Books and choose that folder — it says "This folder already contains MMA Books records". Click **Open these books**.

Copying the entire data folder (with the app closed) is also a complete backup.

---

## How the numbers work

- **Revenue** = subtotal + shipping charged, net of refunds. **Sales tax is not revenue** — it's money owed to New York.
- **Expenses** are counted on the date paid (cash basis). Equipment counts in full when bought; depreciation is your CPA's call.
- **Net profit** = revenue − expenses.
- **Taxable amount** on each sale defaults to *subtotal + shipping* when you collected tax (NY taxes shipping on taxable goods), and $0 when you didn't. Tick **Override taxable amount** for partly exempt orders (e.g. resale certificates).
- **No tax rates are stored anywhere.** You enter the tax you actually collected.
- **Refunds** are negative sales linked to the original sale. They copy the original's tax jurisdiction and count in the period they were issued — as a credit to that jurisdiction. A refund can't exceed what's left of the subtotal, shipping, or tax. Refunding a sale marked *custom (final sale)* asks for confirmation.
- **Dashboard quarter** is the calendar quarter for revenue/expenses/profit; the sales-tax figure next to it uses the current NY filing period.

### Sales tax report

Pick a NY quarterly filing period — **Mar–May, Jun–Aug, Sep–Nov, Dec–Feb** (with its due date, the 20th, moved past weekends) — or any custom date range. One row per **state + county**, split further by **city/locality** when one was entered (e.g. *New York City*). Columns: gross sales, refunds, net sales, taxable, nontaxable, tax collected, tax refunded, net tax, with New York, outside-New-York, and grand totals. Export to CSV or print. Records flagged for review in the period are called out before you file.

### Tax set-aside

Two targets per tax year, plus a combined **"Move $X more"** (or "Ahead by $X"):

- **Income tax:** net profit × your percentage (default 25%, change it in Settings). No target in a year with a loss.
- **Sales tax:** 100% of net sales tax collected (tax collected minus tax refunded).

Log entries as *moved into tax savings*, *moved back out*, or *paid tax from savings*. Paying a tax bill from the savings account doesn't count against your progress — it only lowers the expected balance. An entry's **tax year** can differ from its date (e.g. a January deposit for last year).

### Owner funds

Any payment method can be marked **Owner funds** (one called *Personal funds* is set up for you). Expenses paid that way are still business expenses, and they also add to a running **"owed to owner"** total shown on the dashboard. Record repayments under **Owner funds → Record reimbursement**; the app won't let you record more than the business owes you.

### Expense categories and Schedule C

Starting categories (all editable under **Settings**):

| Category | Suggested Schedule C line |
|---|---|
| Materials & supplies (acrylic sheet) | Part III, line 38 — materials and supplies (cost of goods sold) |
| Tooling / bits | Line 22 — Supplies |
| Shipping / postage | Line 27a — Other expenses |
| Software / subscriptions | Line 27a — Other expenses |
| Equipment | Line 13 — Depreciation and section 179 (Form 4562) |
| Advertising | Line 8 — Advertising |
| Fees (Shopify / payment processing) | Line 10 — Commissions and fees |
| Other | Line 27a — Other expenses |

These assume a **single-member LLC** filing Schedule C. **A multi-member LLC files Form 1065** (partnership return), which uses different lines. Either way, have your CPA confirm the mapping. Categories in use can be archived (hidden from new entries) but not deleted.

---

## Shopify import

1. Shopify admin → **Orders** → filter the dates → **Export** → *Plain CSV file*.
2. **Shopify import → Choose CSV file…** (or drag the file in).
3. Review the preview, then click **Import**. Nothing is saved before that.

What the importer does:

- Groups Shopify's one-row-per-line-item layout into orders (order totals appear only on the first row). Handles quoted fields, line breaks inside fields, and the byte-order mark.
- **Column mapping** is detected automatically and remembered; open *Column mapping* to point any field at a different column.
- **Skips duplicates by order number** (e.g. `#1042`), so overlapping exports are safe. Orders in the Trash are skipped too unless you tick *Re-import orders that are in the Trash*.
- **Skips** unpaid/voided orders and orders in other currencies, showing the reason. Orders whose numbers can't be read are shown as errors, not guessed at.
- Date = *Paid at* (or *Created at* if blank). Customers are matched by email, then name, or created.
- **County:** the export has no county column. The importer reads it from Shopify's tax-line names (e.g. "Suffolk County Tax"). If it can't, New York orders are listed by ZIP for you to choose the county once; your answer is remembered for future imports. Orders with no ship-to address (pickups) use your business location from Settings.
- **Refunds:** Shopify's export gives only a total refunded amount. The importer creates a linked refund, splits it across merchandise/shipping/tax in proportion to the order, and **flags it for review** so you can check the split and date against Shopify. Re-importing a later export picks up refunds issued since the last import.
- Each order can be ticked **Custom** (final sale) or left out in the preview.
- **Import history** lets you undo (and redo) a whole import.
- Shopify fees and payouts aren't in this export — enter Shopify fees as expenses in the *Fees* category.

---

## Exports

**Backup & export → Export CSV** saves sales, expenses (with receipt file paths and Schedule C lines), or the sales tax report for any date range. Files open in Excel; amounts are plain numbers with refunds and credits negative. Text that looks like a spreadsheet formula is prefixed with an apostrophe so Excel won't run it.

---

## Tests

```bash
npm test
```

Uses Node's built-in test runner (no test library). 59 tests across:

| File | Covers |
|---|---|
| `test/money.test.js` | Parsing typed amounts, formatting, rounding percentages, proportional splits that always add up exactly |
| `test/dates.test.js` | NY filing periods (incl. Dec–Feb across years and leap years), due dates, Shopify timestamps |
| `test/csv.test.js` | CSV parsing edge cases, malformed files, writing and formula-safety |
| `test/taxReport.test.js` | Grouping by state/county/locality, refunds credited in later periods, deleted and out-of-range records excluded, totals, CSV export, dashboard figures |
| `test/shopifyImport.test.js` | Multi-row orders, mapping, duplicates, county lookup, refund splits, re-import picking up new refunds, undo/restore of an import |
| `test/sales.test.js` | Validation, order-number uniqueness, refund limits, delete/undo cascades |
| `test/expenses.test.js` | Receipts, categories, owner funds, set-aside targets |
| `test/backup.test.js` | Backups, keep-30 rotation, unreachable backup folder, restore round trip |

---

## Project layout

```
src/
  shared/      money.js, dates.js, geo.js — used by both the app engine and the UI
  core/        the bookkeeping engine: schema/migrations, sales, expenses, reports,
               set-aside, owner funds, Shopify import, exports, backups (no Electron imports;
               fully covered by the tests)
  main/        Electron main process: window, dialogs, files, backups on close; preload bridge
  renderer/    the UI — plain HTML/CSS/JavaScript modules, no framework or build step
test/          node:test suites
build/         app icon used by the installer
```

Dependencies are exactly three: `better-sqlite3` (database), and for development `electron` and `electron-builder`. `better-sqlite3` ships prebuilt binaries for Windows, macOS, and Linux using Node's stable ABI, so no native compiler is needed.

Security: the UI runs sandboxed with context isolation and a strict Content Security Policy, has no Node or file access, and can only call a fixed list of operations in the main process. All user text is inserted as text, never HTML.

The database schema is versioned (`PRAGMA user_version`) with forward-only migrations, so later versions (phase 2: invoices/quotes with deposits, mileage log, sheet-stock inventory) will upgrade existing books in place. Tables are `STRICT`, so a fractional cent can't be stored even by mistake.

---

## Troubleshooting

- **"Couldn't open your data folder" at startup** — the folder was moved, renamed, or is on a drive that isn't connected. Reconnect it and restart, or choose the folder again.
- **Backup warning on the dashboard** — the backup folder wasn't reachable when the app closed. Check the share/drive, then use **Back up now**.
- **A receipt won't open** — **Backup & export → Open data folder** and check `receipts\`; if files are missing, restoring copies them back from the backup folder's receipts mirror.
- For automated UI testing only, the environment variable `MMA_BOOKS_USER_DATA` points the app at a throwaway settings folder.
