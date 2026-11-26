import { h, clear, money, moneyCell, date } from '../dom.js';
import { call, lookups } from '../api.js';
import { pageHead, button, field, formValues, showFormError, openModal, undoToast, toast } from '../ui.js';
import { centsToDecimal } from '../../../shared/money.js';

function openReimbursementForm({ item, today, owed, onSaved }) {
  const form = h(
    'form',
    { class: 'form-grid', onsubmit: (e) => e.preventDefault() },
    field({ label: 'Date', name: 'reimbursement_date', type: 'date', value: item?.reimbursement_date || today, required: true }),
    field({ label: 'Amount repaid to you', name: 'amount', type: 'money', value: item ? centsToDecimal(item.amount_cents) : '', required: true, help: item ? '' : `The business owes you ${money(owed)}` }),
    h('div', { class: 'span-2' }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: item?.notes || '', span: 6, placeholder: 'e.g. Transfer from business checking' }),
  );
  const actions = [];
  if (item) {
    actions.push({
      label: 'Delete',
      danger: true,
      left: true,
      onClick: async () => {
        await call('owner.deleteReimbursement', { id: item.id });
        undoToast('Reimbursement deleted.', () => call('owner.restoreReimbursement', { id: item.id }), onSaved);
        await onSaved();
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save',
    primary: true,
    onClick: async () => {
      try {
        const values = formValues(form);
        if (item) await call('owner.updateReimbursement', { id: item.id, ...values });
        else await call('owner.createReimbursement', values);
      } catch (e) {
        showFormError(form, e);
        return false;
      }
      toast('Saved.', { type: 'success', timeout: 2000 });
      await onSaved();
    },
  });
  openModal({ title: item ? 'Edit reimbursement' : 'Record a reimbursement', content: form, actions });
}

export async function render(page, params, ctx) {
  const L = await lookups({ refresh: true });
  const body = h('div');
  const load = async () => {
    const [s, list] = await Promise.all([call('owner.summary'), call('owner.listReimbursements')]);
    const ownerMethods = L.paymentMethods.filter((p) => p.is_owner_funds).map((p) => p.name);
    clear(body).append(
      h(
        'div',
        { class: 'grid-3' },
        h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'The business owes you'), h('div', { class: ['big-callout', s.owed_to_owner < 0 && 'neg'] }, money(s.owed_to_owner)), h('div', { class: 'callout-sub small' }, 'all time')),
        h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Paid personally (all time)'), h('div', { class: 'big-callout' }, money(s.contributed_all)), h('div', { class: 'callout-sub small' }, `${money(s.contributed_year)} in ${s.year}`)),
        h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Reimbursed to you (all time)'), h('div', { class: 'big-callout' }, money(s.reimbursed_all)), h('div', { class: 'callout-sub small' }, `${money(s.reimbursed_year)} in ${s.year}`)),
      ),
      h(
        'div',
        { class: 'note-box section' },
        `Expenses paid with ${ownerMethods.length ? ownerMethods.map((n) => `"${n}"`).join(' or ') : 'a payment method marked "owner funds"'} count here. They are still business expenses; this tracks the money you put in. Leave the balance as a contribution, or record repayments below when the business pays you back. Mark other payment methods as owner funds in Settings.`,
        ' ',
        button('View those expenses', () => ctx.navigate('expenses', { owner: '1' }), { link: true }),
      ),
      h('div', { class: 'section' }, h('div', { class: 'card-head' }, h('h2', null, 'Reimbursements'), h('div', { class: 'actions' }, button('+ Record reimbursement', () => openReimbursementForm({ today: L.today, owed: s.owed_to_owner, onSaved: load }), { primary: true }))),
        list.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'data' },
                h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Notes'))),
                h('tbody', null, list.map((r) => h('tr', { class: 'clickable', onclick: () => openReimbursementForm({ item: r, today: L.today, owed: s.owed_to_owner, onSaved: load }) }, h('td', null, date(r.reimbursement_date)), moneyCell(r.amount_cents), h('td', null, r.notes)))),
              ),
            )
          : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, 'No reimbursements recorded.')),
      ),
    );
  };
  page.append(pageHead('Owner funds', 'Business expenses you paid with personal money, and what the business has paid back.'), body);
  await load();
}
