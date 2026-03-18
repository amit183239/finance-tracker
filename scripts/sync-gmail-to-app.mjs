#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const APP_URL = process.env.FINANCE_APP_URL || 'https://finance-tracker.amit-maurya173.workers.dev';
const INCLUDE_TRASH = process.env.INCLUDE_TRASH === '1';
const days = Number(process.argv[2] || 7);

function parseJsonBlock(out) {
  const marker = '--- JSON (for agent) ---';
  const i = out.lastIndexOf(marker);
  if (i === -1) throw new Error('JSON marker not found in fetch output');
  const s = out.slice(i + marker.length).trim();
  return JSON.parse(s);
}

function toIsoDate(indiaDate) {
  // e.g. "10 Mar 2026"
  const parts = String(indiaDate || '').trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [d, mon, y] = parts;
  const mm = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}[mon];
  if (!mm) return null;
  return `${y}-${mm}-${String(Number(d)).padStart(2,'0')}`;
}

function detectCardId(t, bankToCardId, last4ToCardId) {
  const cardText = `${t.card || ''} ${t.subject || ''} ${t.snippet || ''}`;
  const m4 = cardText.match(/(?:xx|\*{2,4}|ending\s*(?:in|with)?\s*)(\d{4})/i) || cardText.match(/(\d{4})/);
  if (m4 && last4ToCardId[m4[1]] != null) return last4ToCardId[m4[1]];

  const txt = `${t.subject || ''} ${t.from || ''} ${t.snippet || ''}`.toLowerCase();
  if (txt.includes('hsbc')) return bankToCardId.hsbc ?? null;
  if (txt.includes('hdfc')) return bankToCardId.hdfc ?? null;
  if (txt.includes('icici')) return bankToCardId.icici ?? null;
  if (txt.includes('kotak')) return bankToCardId.kotak ?? null;
  if (txt.includes('axis')) return bankToCardId.axis ?? null;
  if (txt.includes('indusind')) return bankToCardId.indusind ?? null;
  if (txt.includes('sbi')) return bankToCardId.sbi ?? null;
  if (txt.includes('yes bank') || txt.includes('yesbank')) return bankToCardId.yes ?? null;
  if (txt.includes('bobcard') || txt.includes('bob card') || txt.includes('bank of baroda')) return bankToCardId.bob ?? null;
  return null;
}

function extractAmountLoose(t) {
  const pool = [t.amount, t.snippet, t.subject].filter(Boolean).join(' ');
  const m = pool.match(/(?:inr|rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i) || pool.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:inr|rs\.?|₹)/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeMerchant(t) {
  let merchant = (t.merchant || '').trim();
  const snippet = String(t.snippet || '');
  const cardText = `${t.card || ''} ${t.subject || ''} ${t.snippet || ''}`;
  const last4 = cardText.match(/(?:xx|\*{2,4}|ending\s*(?:in|with)?\s*)(\d{4})/i)?.[1] || null;
  const maybePaymentTo = snippet.match(/for\s+payment\s+to\s+(.+?)(?:\s+on\s|\s+at\s|\.|,|$)/i)?.[1]?.trim();

  if (!merchant || /credit card no ending/i.test(merchant) || /^customer\.?care$/i.test(merchant)) {
    if (maybePaymentTo) merchant = maybePaymentTo;
  }

  if (!merchant || /credit card no ending/i.test(merchant) || /^customer\.?care$/i.test(merchant)) {
    if (/hsbc/i.test(`${t.subject || ''} ${t.from || ''}`)) merchant = 'HSBC Card Purchase';
    else if (/icici/i.test(`${t.subject || ''} ${t.from || ''}`) && last4) merchant = `ICICI Card XX${last4} Transaction`;
  }

  if (!merchant || /^customer\.?care$/i.test(merchant)) merchant = (t.subject || 'Unknown').trim();
  return merchant.slice(0, 120);
}

function validTxn(t) {
  const txt = `${t.subject || ''} ${t.snippet || ''}`.toLowerCase();
  if (!t.date) return false;

  // obvious non-card/non-spend messages
  if (txt.includes('credited to beneficiary') || txt.includes('beneficiary')) return false;
  if (txt.includes('credited to destination account') || txt.includes('destination account')) return false;
  if (txt.includes('a/c') && txt.includes('credited')) return false;
  if (txt.includes('thank you for your payment') || txt.includes('status of your kotak credit card bill payment') || txt.includes('credit card bill is due')) return false;
  if (txt.includes('account balance') || txt.includes('available balance') || txt.includes('savings account')) return false;
  if (txt.includes('exchange rate') || txt.includes('forex rate') || txt.includes('interest rates')) return false;
  if (txt.includes('running accou') || txt.includes('running account')) return false;
  if (txt.includes('mandates that in case a client')) return false;
  if (txt.includes('premium of inr') && txt.includes('auto-debited')) return false;
  if (txt.includes('will be auto-debited from registered')) return false;

  // known noisy classes
  if (txt.includes('declined') || txt.includes('reversed') || txt.includes('standing instruction')) return false;
  if (txt.includes('offer') || txt.includes('offers') || txt.includes('reward points') || txt.includes('newsletter')) return false;
  if (txt.includes('wallet') && (txt.includes('credit has been added') || txt.includes('credit added'))) return false;
  if (txt.includes('pepperfry wallet')) return false;
  if (txt.includes('secure your') && txt.includes('credit card dues')) return false;
  if (txt.includes('exciting fashion offers')) return false;

  // loan / EMI marketing (not card transactions)
  if (txt.includes('pre-approved loan') || txt.includes('pre approved loan')) return false;
  if (txt.includes('loan on credit card') || txt.includes('loan up to')) return false;
  if (txt.includes('quick loan') || txt.includes('personal loan') || txt.includes('loan account')) return false;
  if (txt.includes('flexipay') || txt.includes('easy emi') || txt.includes('minimum amount due')) return false;
  if (txt.includes('convert to emi') || txt.includes('emi booking')) return false;
  if (txt.includes('split your card bill into emis') || txt.includes('check emi') || txt.includes('service update')) return false;
  if (txt.includes('take care of your payments with just a few tap')) return false;
  if (txt.includes('your guide to smart credit card usage') || txt.includes('complimentary add-on sbi credit card') || txt.includes('no additional cost')) return false;

  // noisy disclaimer fragments often parsed as fake merchants
  if (txt.includes('sole discretion of icici bank')) return false;

  return true;
}

async function api(path, opts={}) {
  const r = await fetch(`${APP_URL}${path}`, { headers: { 'content-type': 'application/json' }, ...opts });
  const text = await r.text();
  if (!r.ok) throw new Error(`API ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const args = ['/root/clawd/skills/gmail-transactions/scripts/fetch-transactions.js', '--days', String(days)];
if (INCLUDE_TRASH) args.push('--query', `(subject:transaction OR subject:payment OR subject:debit OR subject:credit OR subject:spent OR subject:txn OR subject:upi OR subject:"txn alert" OR subject:"transaction alert" OR subject:"upi txn") in:anywhere newer_than:${days}d`);
const raw = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const parsed = parseJsonBlock(raw);

const cards = await api('/api/cards');
const bankToCardId = {};
const last4ToCardId = {};
for (const c of cards || []) {
  const b = String(c.bank || '').toLowerCase();
  const l4 = String(c.last4 || '').trim();
  if (/^\d{4}$/.test(l4) && last4ToCardId[l4] == null) last4ToCardId[l4] = c.id;
  if (b.includes('hsbc') && bankToCardId.hsbc == null) bankToCardId.hsbc = c.id;
  if (b.includes('hdfc') && bankToCardId.hdfc == null) bankToCardId.hdfc = c.id;
  if (b.includes('icici') && bankToCardId.icici == null) bankToCardId.icici = c.id;
  if (b.includes('kotak') && bankToCardId.kotak == null) bankToCardId.kotak = c.id;
  if (b.includes('axis') && bankToCardId.axis == null) bankToCardId.axis = c.id;
  if (b.includes('indusind') && bankToCardId.indusind == null) bankToCardId.indusind = c.id;
  if (b.includes('sbi') && bankToCardId.sbi == null) bankToCardId.sbi = c.id;
  if (b.includes('yes') && bankToCardId.yes == null) bankToCardId.yes = c.id;
  if ((b.includes('bob') || b.includes('baroda')) && bankToCardId.bob == null) bankToCardId.bob = c.id;
}

const start = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
const existing = await api(`/api/transactions?start=${start}`);
const existingSet = new Set(existing.map(t => `${t.txn_date}|${(t.merchant||'').trim().toLowerCase()}|${Number(t.amount)}|${t.txn_type}|${t.card_id ?? 'null'}`));
const existingLooseSet = new Set(existing.map(t => `${t.txn_date}|${(t.merchant||'').trim().toLowerCase()}|${Number(t.amount)}|${t.txn_type}`));

let scanned = 0, inserted = 0, skipped = 0;
for (const t of (parsed.transactions || [])) {
  scanned++;
  if (!validTxn(t)) { skipped++; continue; }
  const txn_date = toIsoDate(t.date);
  const amount = extractAmountLoose(t);
  const merchant = normalizeMerchant(t);
  const txn_type = 'debit';
  const card_id = detectCardId(t, bankToCardId, last4ToCardId);
  if (!txn_date || !Number.isFinite(amount) || amount <= 0 || !merchant) { skipped++; continue; }
  if (card_id == null) { skipped++; continue; }

  const m = merchant.toLowerCase();
  if (m === 'rates.' || m === 'with us' || m === 'emis hello' || m === 'left' || m === 'does this mean' || m === 'february 16' || m === 'connect.' || m.includes('sole discretion of icici bank') || m.includes('take care of your payments with just a few tap') || m.includes('this message or mail address. for any queries') || m.includes('maintain your credit score') || m.includes('unsubscribe') || m.includes('can be levied on any single transaction') || m.includes('policy status remains in-force') || m.includes('your premiums are paid on time') || m.includes('to emis')) { skipped++; continue; }

  if (amount >= 100000 && (m.includes('available credit limit') || m.includes('available credit l') || m.includes('loan'))) { skipped++; continue; }

  const key = `${txn_date}|${merchant.toLowerCase()}|${amount}|${txn_type}|${card_id ?? 'null'}`;
  const looseKey = `${txn_date}|${merchant.toLowerCase()}|${amount}|${txn_type}`;
  if (existingSet.has(key) || existingLooseSet.has(looseKey)) { skipped++; continue; }

  await api('/api/transactions', {
    method: 'POST',
    body: JSON.stringify({ txn_date, merchant, amount, txn_type, category: 'auto-import', notes: `gmail-sync ${new Date().toISOString().slice(0,10)}`, card_id })
  });
  existingSet.add(key);
  existingLooseSet.add(looseKey);
  inserted++;
}

console.log(JSON.stringify({ ok: true, days, includeTrash: INCLUDE_TRASH, scanned, inserted, skipped, app: APP_URL }));
