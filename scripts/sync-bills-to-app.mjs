#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const APP_URL = process.env.FINANCE_APP_URL || 'https://finance-tracker.amit-maurya173.workers.dev';
const days = Number(process.argv[2] || 2);

function parseJsonBlock(out) {
  const marker = '--- JSON (for agent) ---';
  const i = out.lastIndexOf(marker);
  if (i === -1) throw new Error('JSON marker not found in fetch output');
  return JSON.parse(out.slice(i + marker.length).trim());
}

function toIsoDate(indiaDate) {
  if (!indiaDate) return null;
  const parts = String(indiaDate).trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [d, mon, y] = parts;
  const mm = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' }[mon.slice(0,3)];
  if (!mm) return null;
  return `${y}-${mm}-${String(Number(d)).padStart(2, '0')}`;
}

function extractLast4(t) {
  const pool = `${t.card || ''} ${t.subject || ''} ${t.snippet || ''}`;
  const m = pool.match(/(?:xx|\*{2,4})\s*(\d{4})/i) || pool.match(/ending\s*(?:with)?\s*(\d{4})/i);
  return m ? m[1] : null;
}

function parseAmount(raw) {
  if (!raw) return null;
  const m = String(raw).match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseLabeledAmount(text, labels) {
  const s = String(text || '');
  for (const lbl of labels) {
    const re = new RegExp(`${lbl}[^\\d]{0,20}([\\d,]+(?:\\.\\d{1,2})?)`, 'i');
    const m = s.match(re);
    if (m) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractDueDateIso(t) {
  const txt = `${t.subject || ''} ${t.snippet || ''}`;
  const m = txt.match(/(?:due(?:\s+date)?(?:\s+is|\s+on|\s+by|\s*[:\-])?)\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s*,?\s*\d{4})/i);
  if (!m) return null;
  const s = m[1].replace(',', '');
  const d = new Date(`${s} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function likelyBillMail(t) {
  const txt = `${t.subject || ''} ${t.snippet || ''}`.toLowerCase();
  return (
    txt.includes('bill') ||
    txt.includes('statement') ||
    txt.includes('payment due') ||
    txt.includes('total due') ||
    txt.includes('minimum due') ||
    txt.includes('credit card xx')
  );
}

function likelyBillPaymentMail(t) {
  const txt = `${t.subject || ''} ${t.snippet || ''}`.toLowerCase();
  return (
    txt.includes('payment received') ||
    txt.includes('bill payment') ||
    txt.includes('payment of inr') ||
    txt.includes('payment towards') ||
    txt.includes('payment has been received') ||
    (txt.includes('credit card') && txt.includes('payment') && txt.includes('received'))
  );
}

function detectBank(text='') {
  const t = String(text).toLowerCase();
  if (t.includes('hdfc')) return 'hdfc';
  if (t.includes('icici')) return 'icici';
  if (t.includes('axis')) return 'axis';
  if (t.includes('kotak')) return 'kotak';
  if (t.includes('hsbc')) return 'hsbc';
  if (t.includes('indusind')) return 'indusind';
  if (t.includes('sbi')) return 'sbi';
  if (t.includes('yes bank') || t.includes('yesbank')) return 'yes';
  return null;
}

function sameAmount(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1;
}

async function api(path, opts = {}) {
  const r = await fetch(`${APP_URL}${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  const text = await r.text();
  if (!r.ok) throw new Error(`API ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const query = `(subject:(bill OR statement OR due OR "payment due" OR "total due" OR "minimum due" OR "payment received" OR "bill payment") OR "credit card bill") in:anywhere newer_than:${days}d`;
const raw = execFileSync('node', ['/root/clawd/skills/gmail-transactions/scripts/fetch-transactions.js', '--days', String(days), '--query', query], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

const parsed = parseJsonBlock(raw);
const cards = await api('/api/cards');
const last4ToCard = new Map();
for (const c of cards || []) {
  if (c.last4) last4ToCard.set(String(c.last4), c);
}

let scanned = 0;
let upserted = 0;
let skipped = 0;
let paymentUpdated = 0;

for (const t of parsed.transactions || []) {
  scanned++;
  if (!likelyBillMail(t)) { continue; }

  const last4 = extractLast4(t);
  if (!last4 || !last4ToCard.has(last4)) { skipped++; continue; }

  const card = last4ToCard.get(last4);
  const statementDate = toIsoDate(t.date);
  const combined = `${t.subject || ''} ${t.snippet || ''}`;
  const dueDate = extractDueDateIso(t);

  // Prefer explicit labels over generic parsed amount.
  const totalDueFromText = parseLabeledAmount(combined, ['total\\s+amount\\s+due', 'total\\s+due']);
  const minDueFromText = parseLabeledAmount(combined, ['minimum\\s+amount\\s+due', 'minimum\\s+due', 'min\\s+due']);

  let billAmount = totalDueFromText ?? parseAmount(t.amount);
  let minDue = minDueFromText;

  // If parser amount equals minimum due and total due exists in text, fix mapping.
  if (totalDueFromText != null && minDueFromText != null && billAmount === minDueFromText) {
    billAmount = totalDueFromText;
    minDue = minDueFromText;
  }

  // Need at least a due date or an amount to be useful.
  if (!dueDate && !billAmount) { skipped++; continue; }

  const billMonthBase = dueDate || statementDate || new Date().toISOString().slice(0, 10);
  const billMonth = billMonthBase.slice(0, 7);

  await api('/api/bills', {
    method: 'POST',
    body: JSON.stringify({
      card_id: card.id,
      bill_month: billMonth,
      statement_date: statementDate,
      due_date: dueDate,
      bill_amount: billAmount,
      min_due: Number.isFinite(minDue) ? minDue : null,
      source: 'gmail-bill-sync',
      notes: `subject=${(t.subject || '').slice(0, 120)}`,
    }),
  });

  upserted++;
}

// Reconcile bill payment mails against pending bills.
const allBills = await api('/api/bills');
const pendingBills = (allBills || []).filter((b) => (b.status || 'pending') === 'pending');

for (const t of parsed.transactions || []) {
  if (!likelyBillPaymentMail(t)) continue;

  const combined = `${t.subject || ''} ${t.snippet || ''}`;
  const last4 = extractLast4(t);
  const paymentAmount = parseLabeledAmount(combined, ['payment\\s+of', 'amount\\s+paid', 'payment\\s+received']) ?? parseAmount(t.amount);
  if (!paymentAmount) continue;

  let candidates = [];
  if (last4) {
    candidates = pendingBills.filter((b) => String(b.last4 || '') === String(last4) && sameAmount(b.bill_amount, paymentAmount));
  }

  if (!candidates.length) {
    const bankKey = detectBank(combined);
    if (bankKey) {
      candidates = pendingBills.filter((b) => String(b.bank || '').toLowerCase().includes(bankKey) && sameAmount(b.bill_amount, paymentAmount));
    }
  }

  if (candidates.length === 1) {
    const bill = candidates[0];
    await api(`/api/bills/${bill.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'paid',
        paid_amount: paymentAmount,
        paid_date: toIsoDate(t.date) || new Date().toISOString().slice(0, 10),
        notes: `auto-paid-match: ${(t.subject || '').slice(0, 90)}`,
      }),
    });
    paymentUpdated++;
  }
}

console.log(JSON.stringify({ ok: true, days, scanned, upserted, paymentUpdated, skipped, app: APP_URL }));
