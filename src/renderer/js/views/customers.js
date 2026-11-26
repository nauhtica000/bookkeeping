import { h, clear, money, date, debounce } from '../dom.js';
import { call, invalidateLookups } from '../api.js';
import { pageHead, button, field, formValues, showFormError, openModal, undoToast, toast } from '../ui.js';

let search = '';

function openCustomerForm({ customer, onSaved, ctx }) {
  const c = customer || {};
  const form = h(
    'form',
    { class: 'form-grid', onsubmit: (e) => e.preventDefault() },
    field({ label: 'Name', name: 'name', value: c.name, required: true, span: 3 }),
    field({ label: 'Email', name: 'email', value: c.email, span: 3 }),
    field({ label: 'Phone', name: 'phone', value: c.phone, span: 2 }),
    field({ label: 'Address', name: 'address', type: 'textarea', value: c.address, span: 4, attrs: { rows: 3 } }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: c.notes, span: 6 }),
  );
  const actions = [];
  if (customer) {
    actions.push(
      {
        label: 'Delete',
        danger: true,
        left: true,
        onClick: async () => {
          await call('customers.delete', { id: customer.id });
          invalidateLookups();
          undoToast(`${customer.name} deleted.`, () => call('trash.restore', { type: 'customer', id: customer.id }), onSaved);
          await onSaved();
        },
      },
      { label: 'View sales', left: true, onClick: () => ctx.navigate('sales', { customer: customer.id }) },
      { label: '+ Sale', left: true, onClick: async () => {
        const { openSaleForm } = await import('./sales.js');
        setTimeout(() => openSaleForm({ presetCustomer: customer.name, onSaved }), 0);
      } },
    );
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save',
    primary: true,
    onClick: async () => {
      try {
        const v = formValues(form);
        if (customer) await call('customers.update', { id: customer.id, ...v });
        else await call('customers.create', v);
      } catch (e) {
        showFormError(form, e);
        return false;
      }
      invalidateLookups();
      toast('Customer saved.', { type: 'success', timeout: 2000 });
      await onSaved();
    },
  });
  openModal({ title: customer ? customer.name : 'New customer', content: form, actions, wide: true });
}

export async function render(page, params, ctx) {
  const listBox = h('div');
  const load = async () => {
    const rows = await call('customers.list', { search });
    clear(listBox).append(
      rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'data' },
              h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', null, 'Phone'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Revenue'), h('th', null, 'Last sale'))),
              h(
                'tbody',
                null,
                rows.map((c) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => openCustomerForm({ customer: c, onSaved: load, ctx }) },
                    h('td', null, c.name),
                    h('td', null, c.email || ''),
                    h('td', null, c.phone || ''),
                    h('td', { class: 'num' }, String(c.sale_count)),
                    h('td', { class: 'num' }, money(c.revenue_cents)),
                    h('td', null, c.last_sale_date ? date(c.last_sale_date) : ''),
                  ),
                ),
              ),
            ),
          )
        : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, search ? 'No customers match.' : 'No customers yet. They are added automatically when you enter or import sales.')),
    );
  };
  const box = h('input', { type: 'search', placeholder: 'Name, email, or phone…', value: search, 'aria-label': 'Search customers' });
  box.addEventListener('input', debounce(() => {
    search = box.value;
    load();
  }));
  page.append(
    pageHead('Customers', 'Added automatically from sales and Shopify imports.', button('+ New customer', () => openCustomerForm({ onSaved: load, ctx }), { primary: true })),
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', null, 'Search'), box)),
    listBox,
  );
  await load();
}
