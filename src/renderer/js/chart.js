// Monthly revenue vs. expenses: grouped columns, hand-drawn SVG.
// Two series (categorical slots 1 and 2), legend + hover tooltip + table view.
import { h, s, money } from './dom.js';

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function ticksFor(minCents, maxCents) {
  const lo = Math.min(0, minCents) / 100;
  const hi = Math.max(0, maxCents) / 100;
  const span = hi - lo || 100;
  const step = niceStep(span / 4);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step || step;
  const ticks = [];
  for (let v = start; v <= end + step / 1e6; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function tickLabel(dollars, compact) {
  const sign = dollars < 0 ? '-' : '';
  const a = Math.abs(dollars);
  if (compact) {
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a % 1e3 === 0 ? 0 : 1)}K`;
  }
  return `${sign}$${a.toLocaleString('en-US')}`;
}

// Column path with a 4px rounded data end and a square end on the baseline.
function columnPath(x, w, yBase, yEnd) {
  const hgt = Math.abs(yBase - yEnd);
  if (hgt < 0.5) return '';
  const r = Math.min(4, hgt, w / 2);
  if (yEnd < yBase) {
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

export function monthlyChart(months, { year }) {
  const W = 820;
  const H = 280;
  const m = { l: 64, r: 12, t: 12, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const values = months.flatMap((x) => [x.revenue, x.expenses]);
  const ticks = ticksFor(Math.min(...values, 0), Math.max(...values, 0));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (cents) => m.t + ph - ((cents / 100 - lo) / (hi - lo)) * ph;
  const compact = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;
  const band = pw / 12;
  const barW = Math.min(24, (band - 10) / 2);
  const gap = 2;

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Revenue and expenses by month for ${year}. Details are in the table below the chart.`,
  });
  for (const t of ticks) {
    const yy = y(t * 100);
    svg.append(s('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    svg.append(s('text', { class: 'tick', x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, tickLabel(t, compact)));
  }
  const base = y(0);
  // Hit targets sit under the bars; bars ignore the pointer so the whole
  // month column responds to hover.
  const gHits = s('g');
  const gBars = s('g', { class: 'bars' });
  svg.append(gHits, gBars);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const wrap = h('div', { class: 'chart' });

  months.forEach((mo, i) => {
    const cx = m.l + band * i + band / 2;
    const x1 = cx - barW - gap / 2;
    const x2 = cx + gap / 2;
    const p1 = columnPath(x1, barW, base, y(mo.revenue));
    const p2 = columnPath(x2, barW, base, y(mo.expenses));
    if (p1) gBars.append(s('path', { class: 'bar-rev', d: p1 }));
    if (p2) gBars.append(s('path', { class: 'bar-exp', d: p2 }));
    gBars.append(s('text', { class: 'tick', x: cx, y: H - 10, 'text-anchor': 'middle' }, mo.label));
    // Hit target: the whole month column, bigger than the marks.
    const hit = s('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph, tabindex: '0', 'aria-label': `${mo.label}: revenue ${money(mo.revenue)}, expenses ${money(mo.expenses)}` });
    const show = () => {
      hit.classList.add('on');
      tip.replaceChildren(
        h('div', { class: 'tip-title' }, `${mo.label} ${year}`),
        h('div', { class: 'tip-row' }, h('span', { class: 'k' }, h('span', { class: 'sw rev' }), 'Revenue'), h('span', { class: 'v' }, money(mo.revenue))),
        h('div', { class: 'tip-row' }, h('span', { class: 'k' }, h('span', { class: 'sw exp' }), 'Expenses'), h('span', { class: 'v' }, money(mo.expenses))),
        h('div', { class: 'tip-row' }, h('span', { class: 'k' }, 'Net profit'), h('span', { class: 'v' }, money(mo.net_profit))),
      );
      tip.hidden = false;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / W;
      const left = (m.l + band * (i + 1)) * scale + 8;
      const flip = left + 190 > rect.width;
      tip.style.left = `${flip ? (m.l + band * i) * scale - 190 : left}px`;
      tip.style.top = `${m.t * scale + 8}px`;
    };
    const hide = () => {
      hit.classList.remove('on');
      tip.hidden = true;
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('blur', hide);
    gHits.append(hit);
  });

  const legend = h('div', { class: 'legend' }, h('span', null, h('span', { class: 'key rev' }), 'Revenue'), h('span', null, h('span', { class: 'key exp' }), 'Expenses'));
  wrap.append(svg, tip);

  const table = h(
    'details',
    { class: 'table-view' },
    h('summary', null, 'Show as table'),
    h(
      'div',
      { class: 'table-wrap', style: { marginTop: '8px' } },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Expenses'), h('th', { class: 'num' }, 'Net profit'), h('th', { class: 'num' }, 'Sales tax'))),
        h(
          'tbody',
          null,
          months.map((mo) =>
            h('tr', null, h('td', null, `${mo.label} ${year}`), h('td', { class: 'num' }, money(mo.revenue)), h('td', { class: 'num' }, money(mo.expenses)), h('td', { class: ['num', mo.net_profit < 0 && 'neg'] }, money(mo.net_profit)), h('td', { class: 'num' }, money(mo.sales_tax))),
          ),
        ),
      ),
    ),
  );
  return h('div', null, legend, wrap, table);
}
