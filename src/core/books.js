// One object exposing every operation the UI can perform. The IPC layer only
// lets the renderer call methods listed here; tests use the same object.
import * as settings from './settings.js';
import * as lookups from './lookups.js';
import * as customers from './customers.js';
import * as sales from './sales.js';
import * as expenses from './expenses.js';
import * as reports from './reports.js';
import * as setAside from './setAside.js';
import * as owner from './owner.js';
import * as trash from './trash.js';
import * as shopify from './shopify.js';
import * as exportsMod from './exports.js';
import { ValidationError } from './errors.js';
import { toId } from './util.js';
import { todayLocal, isValidDate, parseDate } from '../shared/dates.js';

export function createBooks({ db, dataDir, clock = () => new Date() }) {
  const now = () => clock().toISOString();
  const today = () => todayLocal(clock());
  const year = (y) => {
    const n = Number(y ?? parseDate(today()).y);
    if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new ValidationError('Invalid year.');
    return n;
  };
  const range = (a = {}) => {
    const from = a.from || null;
    const to = a.to || null;
    if (from && !isValidDate(from)) throw new ValidationError('The "from" date is invalid.');
    if (to && !isValidDate(to)) throw new ValidationError('The "to" date is invalid.');
    if (from && to && from > to) throw new ValidationError('The "from" date is after the "to" date.');
    return { from, to };
  };

  const api = {
    // --- settings & lookups ---
    'settings.get': () => settings.getAllSettings(db),
    'settings.update': (a) => settings.updateBusinessSettings(db, a, now()),
    'lookups.all': () => ({
      settings: settings.getAllSettings(db),
      paymentMethods: lookups.listPaymentMethods(db),
      categories: lookups.listCategories(db),
      customers: customers.customerNames(db),
      localities: sales.localitySuggestions(db),
      vendors: expenses.vendorSuggestions(db),
      today: today(),
    }),
    'paymentMethods.save': (a) => lookups.savePaymentMethod(db, a, now()),
    'paymentMethods.delete': (a) => lookups.deletePaymentMethod(db, a.id, now()),
    'paymentMethods.move': (a) => lookups.movePaymentMethod(db, a.id, a.direction, now()),
    'categories.save': (a) => lookups.saveCategory(db, a, now()),
    'categories.delete': (a) => lookups.deleteCategory(db, a.id, now()),
    'categories.move': (a) => lookups.moveCategory(db, a.id, a.direction, now()),

    // --- customers ---
    'customers.list': (a = {}) => customers.listCustomers(db, a),
    'customers.get': (a) => customers.getCustomer(db, a.id),
    'customers.create': (a) => customers.createCustomer(db, a, now()),
    'customers.update': (a) => customers.updateCustomer(db, a.id, a, now()),
    'customers.delete': (a) => customers.deleteCustomer(db, a.id, now()),

    // --- sales & refunds ---
    'sales.list': (a = {}) => sales.listSales(db, { ...a, ...range(a) }),
    'sales.get': (a) => {
      const s = sales.getSale(db, a.id);
      const original = s.kind === 'refund' ? sales.getSale(db, s.original_sale_id) : s;
      return {
        sale: s,
        refunds: sales.refundsOf(db, original.id),
        remaining: sales.refundableRemaining(db, original.id, { excludeRefundId: s.kind === 'refund' ? s.id : null }),
        original,
      };
    },
    'sales.create': (a) => sales.createSale(db, a, now()),
    'sales.update': (a) => sales.updateSale(db, a.id, a, now()),
    'sales.delete': (a) => sales.deleteSale(db, a.id, now()),
    'sales.restore': (a) => sales.restoreSale(db, a.id, now()),
    'sales.markReviewed': (a) => sales.markReviewed(db, a.id, now()),
    'refunds.create': (a) => sales.createRefund(db, a, now()),

    // --- expenses ---
    'expenses.list': (a = {}) => expenses.listExpenses(db, { ...a, ...range(a) }),
    'expenses.get': (a) => expenses.getExpense(db, a.id),
    'expenses.create': (a) => expenses.createExpense(db, dataDir, a, now()),
    'expenses.update': (a) => expenses.updateExpense(db, dataDir, a.id, a, now()),
    'expenses.delete': (a) => expenses.deleteExpense(db, a.id, now()),
    'expenses.restore': (a) => expenses.restoreExpense(db, a.id, now()),
    'expenses.vendorDefaults': (a) => expenses.lastExpenseForVendor(db, a.vendor),
    'receipts.path': (a) => expenses.receiptFilePath(db, dataDir, a.id),

    // --- reports ---
    'dashboard.get': (a = {}) => {
      const asOf = a.asOf && isValidDate(a.asOf) ? a.asOf : today();
      const y = parseDate(asOf).y;
      return {
        periods: reports.dashboardPeriods(db, asOf),
        months: reports.monthlyTotals(db, year(a.chartYear ?? y)),
        chartYear: year(a.chartYear ?? y),
        years: reports.dataYears(db),
        setAside: setAside.setAsideSummary(db, y),
        owner: owner.ownerFundsSummary(db, y),
        reviewCount: sales.reviewCount(db),
      };
    },
    'reports.salesTax': (a) => reports.salesTaxReport(db, a.from, a.to),

    // --- set-aside ---
    'setAside.summary': (a = {}) => setAside.setAsideSummary(db, year(a.year)),
    'setAside.list': (a = {}) => setAside.listSetAsideEntries(db, year(a.year)),
    'setAside.create': (a) => setAside.createSetAsideEntry(db, a, now()),
    'setAside.update': (a) => setAside.updateSetAsideEntry(db, a.id, a, now()),
    'setAside.delete': (a) => setAside.deleteSetAsideEntry(db, a.id, now()),
    'setAside.restore': (a) => setAside.restoreSetAsideEntry(db, a.id, now()),

    // --- owner funds ---
    'owner.summary': (a = {}) => owner.ownerFundsSummary(db, year(a.year)),
    'owner.listReimbursements': () => owner.listReimbursements(db),
    'owner.createReimbursement': (a) => owner.createReimbursement(db, a, now()),
    'owner.updateReimbursement': (a) => owner.updateReimbursement(db, a.id, a, now()),
    'owner.deleteReimbursement': (a) => owner.deleteReimbursement(db, a.id, now()),
    'owner.restoreReimbursement': (a) => owner.restoreReimbursement(db, a.id, now()),

    'badges.get': () => ({ reviewCount: sales.reviewCount(db) }),

    // --- trash ---
    'trash.list': () => trash.listTrash(db),
    'trash.restore': (a) => trash.restoreFromTrash(db, a.type, a.id, now()),

    // --- Shopify import (file reading happens in the main process) ---
    'import.fields': () => shopify.SHOPIFY_FIELDS,
    'import.history': () => shopify.listImportBatches(db),
    'import.undo': (a) => shopify.undoImport(db, toId(a.id, 'Import'), now()),
    'import.restore': (a) => shopify.restoreImport(db, toId(a.id, 'Import'), now()),
  };

  // Not exposed over IPC directly (they take raw file contents).
  const internal = {
    buildImportPlan: (csvText, opts) => shopify.buildImportPlan(db, csvText, { ...opts, today: today() }),
    commitImportPlan: (plan) => shopify.commitImportPlan(db, plan, now()),
    salesCsv: (a = {}) => exportsMod.salesCsv(db, range(a)),
    expensesCsv: (a = {}) => exportsMod.expensesCsv(db, range(a)),
    taxReportCsv: (a) => exportsMod.taxReportCsv(reports.salesTaxReport(db, a.from, a.to)),
    setSetting: (k, v) => settings.setSetting(db, k, v, now()),
    getSetting: (k) => settings.getSetting(db, k),
    today,
  };

  return { api, internal, db, dataDir };
}
