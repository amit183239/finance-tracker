const el = (id) => document.getElementById(id);
const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

let txnFilterQuery = '';
let selectedCard = null;
let cardMonthOffset = 0;
let breakdownRange = 'month';
let allTxns = [];
let currentPage = 1;
const PAGE_SIZE = 20;

async function api(path, o = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...o });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function monthBounds(offset = 0) {
  const d = new Date();
  const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset, 1));
  const start = `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const l = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0));
  const end = `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
}

function bankClass(bank = '') {
  const b = bank.toLowerCase();
  if (b.includes('hdfc')) return 'bank-hdfc';
  if (b.includes('icici')) return 'bank-icici';
  if (b.includes('axis')) return 'bank-axis';
  if (b.includes('kotak')) return 'bank-kotak';
  if (b.includes('sbi')) return 'bank-sbi';
  if (b.includes('hsbc')) return 'bank-hsbc';
  if (b.includes('indusind')) return 'bank-indusind';
  if (b.includes('yes')) return 'bank-yes';
  return 'bank-default';
}

async function loadCards() {
  const [{ start }, cards, txns] = await Promise.all([
    Promise.resolve(monthBounds(0)),
    api('/api/cards'),
    api(`/api/transactions?start=${monthBounds(0).start}`),
  ]);

  const grid = el('cardsGrid');
  grid.innerHTML = '';

  const enriched = cards
    .map((c) => {
      const spend = txns
        .filter((t) => Number(t.card_id) === Number(c.id) && t.txn_type === 'debit' && t.txn_date >= start)
        .reduce((a, t) => a + Number(t.amount || 0), 0);
      return { ...c, displayName: c.card_name, computedSpend: spend };
    })
    .sort((a, b) => b.computedSpend - a.computedSpend);

  enriched.forEach((c) => {
    const d = document.createElement('div');
    d.className = `card-tile ${bankClass(c.bank)}`;
    d.innerHTML = `<div class='card-top'><div><div><strong>${c.displayName}</strong></div><div class='bank'>${c.bank}</div></div><div class='l4'>•••• ${c.last4}</div></div><div class='cycle'>Spend: <strong>${fmt(c.computedSpend)}</strong></div><div class='meta'>Current month</div>`;
    d.addEventListener('click', () => {
      selectedCard = c;
      cardMonthOffset = 0;
      renderCardDetail();
    });
    grid.appendChild(d);
  });
}

async function renderCardDetail() {
  if (!selectedCard) return;
  el('cardDetail').classList.remove('hidden');
  el('cardDetailTitle').textContent = `${selectedCard.card_name} ••••${selectedCard.last4}`;
  el('cardCurrentBtn').classList.toggle('active', cardMonthOffset === 0);
  el('cardPrevBtn').classList.toggle('active', cardMonthOffset === 1);

  const { start, end } = monthBounds(cardMonthOffset);
  const txns = await api(`/api/transactions?start=${start}&end=${end}&card_id=${selectedCard.id}&type=debit`);
  const list = el('cardTxnsList');
  list.innerHTML = '';

  if (!txns.length) {
    list.innerHTML = "<li><div class='small'>No transactions in this month</div></li>";
    return;
  }

  txns.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `<div><strong>${t.merchant}</strong><div class='small'>${t.txn_date} • ${t.category || 'Uncategorized'}</div></div><div><strong>${fmt(t.amount)}</strong></div>`;
    list.appendChild(li);
  });
}

async function loadSummary() {
  const s = await api('/api/summary');
  el('weeklySpend').textContent = fmt(s.weeklySpend);
  el('monthlySpend').textContent = fmt(s.monthlySpend);
}

function renderBreakdownList(targetId, rows) {
  const list = el(targetId);
  list.innerHTML = '';

  if (!rows?.length) {
    list.innerHTML = "<li><div class='small'>No data</div></li>";
    return;
  }

  rows.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<div><strong>${r.name}</strong><div class='small'>${r.count} txns</div></div><div><strong>${fmt(r.total)}</strong></div>`;
    list.appendChild(li);
  });
}

function breakdownBounds(range) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (range === 'week') {
    const day = now.getUTCDay();
    const diff = (day + 6) % 7;
    const startDate = new Date(Date.UTC(y, m, d - diff));
    const start = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(startDate.getUTCDate()).padStart(2, '0')}`;
    const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { start, end };
  }

  if (range === 'quarter') {
    const qStartMonth = Math.floor(m / 3) * 3;
    const start = `${y}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
    const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { start, end };
  }

  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start, end };
}

async function loadBreakdown() {
  const p = new URLSearchParams(txnFilterQuery);
  const { start, end } = breakdownBounds(breakdownRange);
  p.set('start', start);
  p.set('end', end);
  const q = p.toString();

  const b = await api(`/api/breakdown${q ? `?${q}` : ''}`);
  renderBreakdownList('topMerchants', b.topMerchants);
  renderBreakdownList('topCategories', b.topCategories);
}

function renderTransactionsPage() {
  const list = el('txnsList');
  list.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(allTxns.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = allTxns.slice(start, start + PAGE_SIZE);

  pageItems.forEach((t) => {
    const li = document.createElement('li');
    const last4 = t.last4 ? `••••${t.last4}` : '••••----';
    li.innerHTML = `<div><strong>${t.merchant}</strong><div class='small'>${t.txn_date} • ${t.category || 'Uncategorized'} • ${last4}</div></div><div><strong>${fmt(t.amount)}</strong></div>`;
    list.appendChild(li);
  });

  el('pageInfo').textContent = `Page ${currentPage} / ${totalPages}`;
  el('prevPageBtn').disabled = currentPage <= 1;
  el('nextPageBtn').disabled = currentPage >= totalPages;
}

async function loadTransactions() {
  allTxns = await api(`/api/transactions${txnFilterQuery ? `?${txnFilterQuery}` : ''}`);
  currentPage = 1;
  renderTransactionsPage();
}

el('cardCurrentBtn')?.addEventListener('click', async () => {
  cardMonthOffset = 0;
  await renderCardDetail();
});

el('cardPrevBtn')?.addEventListener('click', async () => {
  cardMonthOffset = 1;
  await renderCardDetail();
});

el('txnFilters').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const p = new URLSearchParams();

  const month = String(fd.get('month') || '').trim();
  const start = String(fd.get('start') || '').trim();
  const end = String(fd.get('end') || '').trim();

  if (month) {
    const ms = `${month}-01`;
    const d = new Date(`${ms}T00:00:00Z`);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const me = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
    p.set('start', start || ms);
    p.set('end', end || me);
  } else {
    if (start) p.set('start', start);
    if (end) p.set('end', end);
  }

  const type = String(fd.get('type') || '').trim();
  const q = String(fd.get('q') || '').trim();
  if (type) p.set('type', type);
  if (q) p.set('q', q);

  txnFilterQuery = p.toString();
  await Promise.all([loadTransactions(), loadBreakdown()]);
});

el('breakdownRange')?.addEventListener('change', async (e) => {
  breakdownRange = e.target.value || 'month';
  await loadBreakdown();
});

el('prevPageBtn')?.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderTransactionsPage();
  }
});

el('nextPageBtn')?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(allTxns.length / PAGE_SIZE));
  if (currentPage < totalPages) {
    currentPage += 1;
    renderTransactionsPage();
  }
});

function applyViewMode(mode) {
  const m = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
  document.documentElement.setAttribute('data-theme', m);
  localStorage.setItem('viewMode', m);
}

function initViewMode() {
  const saved = localStorage.getItem('viewMode') || 'system';
  const select = el('viewModeSelect');
  if (select) {
    select.value = ['system', 'light', 'dark'].includes(saved) ? saved : 'system';
    select.addEventListener('change', (e) => applyViewMode(e.target.value));
  }
  applyViewMode(saved);
}

initViewMode();

Promise.all([loadCards(), loadSummary(), loadTransactions(), loadBreakdown()]).catch(() =>
  alert('Failed to load'),
);
