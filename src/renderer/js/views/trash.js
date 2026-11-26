import { h, clear, money, date, formatTimestamp } from '../dom.js';
import { call, invalidateLookups } from '../api.js';
import { pageHead, button, toast, showError } from '../ui.js';

const SECTIONS = [
  ['sales', 'Sales and refunds', 'sale', (r) => [date(r.sale_date), r.kind === 'refund' ? `Refund of ${r.original_order_number || 'sale'}` : r.order_number || '—', r.customer_name || '', money(r.total_cents)]],
  ['expenses', 'Expenses', 'expense', (r) => [date(r.expense_date), r.vendor, r.category_name, money(r.amount_cents)]],
  ['receipts', 'Receipts removed from expenses', 'receipt', (r) => [date(r.expense_date), r.original_name, r.vendor, '']],
  ['customers', 'Customers', 'customer', (r) => ['', r.name, r.email || '', '']],
  ['setAside', 'Set-aside entries', 'setAside', (r) => [date(r.entry_date), `${r.bucket === 'sales_tax' ? 'Sales tax' : 'Income tax'} — ${r.entry_type.replace('_', ' ')}`, `Tax year ${r.tax_year}`, money(r.amount_cents)]],
  ['reimbursements', 'Owner reimbursements', 'reimbursement', (r) => [date(r.reimbursement_date), r.notes || 'Reimbursement', '', money(r.amount_cents)]],
  ['imports', 'Undone Shopify imports', 'import', (r) => [formatTimestamp(r.created_at), r.file_name, `${r.sales_created} sales, ${r.refunds_created} refunds`, '']],
  ['categories', 'Expense categories', 'category', (r) => ['', r.name, '', '']],
  ['paymentMethods', 'Payment methods', 'paymentMethod', (r) => ['', r.name, '', '']],
];

export async function render(page, params, ctx) {
  const body = h('div');
  const load = async () => {
    const t = await call('trash.list');
    const cards = SECTIONS.filter(([key]) => t[key]?.length).map(([key, title, type, cols]) =>
      h(
        'div',
        { class: 'card' },
        h('h2', null, `${title} (${t[key].length})`),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Item'), h('th', null, ''), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Deleted'), h('th', null, ''))),
            h(
              'tbody',
              null,
              t[key].map((r) => {
                const [d, a, b, amt] = cols(r);
                return h(
                  'tr',
                  null,
                  h('td', { class: 'nowrap' }, d),
                  h('td', null, a),
                  h('td', { class: 'muted' }, b),
                  h('td', { class: 'num' }, amt),
                  h('td', { class: 'nowrap small muted' }, formatTimestamp(r.deleted_at)),
                  h('td', { class: 'actions-cell' }, button('Restore', async () => {
                    try {
                      await call('trash.restore', { type, id: r.id });
                      invalidateLookups();
                      toast('Restored.', { type: 'success', timeout: 2000 });
                      load();
                      ctx.refreshSidebar();
                    } catch (e) {
                      showError(e);
                    }
                  }, { small: true })),
                );
              }),
            ),
          ),
        ),
      ),
    );
    clear(body).append(cards.length ? h('div', null, cards) : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'The Trash is empty.')));
  };
  page.append(pageHead('Trash', 'Deleted records are kept here and can be restored. A sale restores together with refunds deleted along with it.'), body);
  await load();
}
