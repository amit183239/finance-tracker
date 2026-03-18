export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const bad = (m: string) => json({ error: m }, 400);

const parse = async <T>(r: Request) => {
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
};

const weekStart = () => {
  const n = new Date();
  const day = n.getUTCDay();
  const diff = (day + 6) % 7;
  n.setUTCDate(n.getUTCDate() - diff);
  n.setUTCHours(0, 0, 0, 0);
  return n.toISOString().slice(0, 10);
};

const monthStart = () => {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

async function ensureBillsSchema(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      bill_month TEXT NOT NULL,
      statement_date TEXT,
      due_date TEXT,
      bill_amount REAL,
      min_due REAL,
      source TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(card_id, bill_month)
    )
  `).run();

  const info = await env.DB.prepare(`PRAGMA table_info(bills)`).all<any>();
  const cols = new Set((info.results || []).map((r: any) => String(r.name)));

  const missing: Array<[string, string]> = [
    ['bill_month', 'TEXT'],
    ['statement_date', 'TEXT'],
    ['due_date', 'TEXT'],
    ['bill_amount', 'REAL'],
    ['min_due', 'REAL'],
    ['source', 'TEXT'],
    ['notes', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['paid_amount', 'REAL'],
    ['paid_date', 'TEXT'],
    ['status', 'TEXT'],
  ].filter(([name]) => !cols.has(name));

  for (const [name, type] of missing) {
    await env.DB.prepare(`ALTER TABLE bills ADD COLUMN ${name} ${type}`).run();
  }

  if (!cols.has('bill_month')) {
    await env.DB.prepare(`UPDATE bills SET bill_month = substr(COALESCE(due_date, statement_date, date('now')), 1, 7) WHERE bill_month IS NULL OR bill_month = ''`).run();
  }

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills(due_date)
  `).run();
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/cards' && request.method === 'GET') {
        const r = await env.DB.prepare(
          `SELECT id, card_name, bank, last4, card_type, credit_limit, billing_day, due_day, is_active
           FROM cards
           ORDER BY is_active DESC, bank, card_name`
        ).all();
        return json(r.results ?? []);
      }

      if (path === '/api/transactions' && request.method === 'GET') {
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        const type = url.searchParams.get('type');
        const cardId = url.searchParams.get('card_id');
        const q = url.searchParams.get('q');

        const c: string[] = [];
        const p: (string | number)[] = [];
        if (start) {
          c.push('t.txn_date >= ?');
          p.push(start);
        }
        if (end) {
          c.push('t.txn_date <= ?');
          p.push(end);
        }
        if (type && ['debit', 'credit'].includes(type)) {
          c.push('t.txn_type = ?');
          p.push(type);
        }
        if (cardId) {
          c.push('t.card_id = ?');
          p.push(Number(cardId));
        }
        if (q) {
          c.push('(LOWER(t.merchant) LIKE ? OR LOWER(COALESCE(t.category,\'\')) LIKE ?)');
          p.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
        }

        const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
        const r = await env.DB.prepare(
          `SELECT t.id,t.txn_date,t.merchant,t.amount,t.txn_type,t.category,t.notes,
                  c.id as card_id,c.card_name,c.last4,c.bank
           FROM transactions t
           LEFT JOIN cards c ON c.id=t.card_id
           ${w}
           ORDER BY t.txn_date DESC,t.id DESC
           LIMIT 1000`
        )
          .bind(...p)
          .all();

        return json(r.results ?? []);
      }

      if (path === '/api/summary' && request.method === 'GET') {
        const ws = weekStart();
        const ms = monthStart();
        const [w, m] = await Promise.all([
          env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE txn_type='debit' AND txn_date >= ?`)
            .bind(ws)
            .first<any>(),
          env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE txn_type='debit' AND txn_date >= ?`)
            .bind(ms)
            .first<any>(),
        ]);
        return json({ weeklySpend: w?.total ?? 0, monthlySpend: m?.total ?? 0 });
      }

      if (path === '/api/breakdown' && request.method === 'GET') {
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        const cardId = url.searchParams.get('card_id');
        const q = url.searchParams.get('q');

        const c = ["txn_type = 'debit'"] as string[];
        const p: (string | number)[] = [];
        if (start) {
          c.push('txn_date >= ?');
          p.push(start);
        }
        if (end) {
          c.push('txn_date <= ?');
          p.push(end);
        }
        if (cardId) {
          c.push('card_id = ?');
          p.push(Number(cardId));
        }
        if (q) {
          c.push('(LOWER(merchant) LIKE ? OR LOWER(COALESCE(category,\'\')) LIKE ?)');
          p.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
        }

        const w = `WHERE ${c.join(' AND ')}`;

        const [m, cat] = await Promise.all([
          env.DB.prepare(
            `SELECT merchant as name, COUNT(*) as count, COALESCE(SUM(amount),0) as total
             FROM transactions ${w}
             GROUP BY merchant
             ORDER BY total DESC
             LIMIT 8`
          )
            .bind(...p)
            .all(),
          env.DB.prepare(
            `SELECT COALESCE(NULLIF(TRIM(category),''),'Uncategorized') as name,
                    COUNT(*) as count,
                    COALESCE(SUM(amount),0) as total
             FROM transactions ${w}
             GROUP BY COALESCE(NULLIF(TRIM(category),''),'Uncategorized')
             ORDER BY total DESC
             LIMIT 8`
          )
            .bind(...p)
            .all(),
        ]);

        return json({ topMerchants: m.results ?? [], topCategories: cat.results ?? [] });
      }

      if (path === '/api/transactions' && request.method === 'POST') {
        const b = await parse<any>(request);
        if (!b || !b.txn_date || !b.merchant || !b.amount || !b.txn_type) {
          return bad('txn_date, merchant, amount, txn_type are required');
        }

        const i = await env.DB.prepare(
          `INSERT INTO transactions (txn_date, merchant, amount, txn_type, category, notes, card_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(b.txn_date, b.merchant, b.amount, b.txn_type, b.category ?? null, b.notes ?? null, b.card_id ?? null)
          .run();

        return json({ ok: true, id: i.meta.last_row_id }, 201);
      }

      if (path.startsWith('/api/transactions/') && request.method === 'DELETE') {
        const id = Number(path.split('/').pop());
        if (!id) return bad('Invalid transaction id');
        await env.DB.prepare('DELETE FROM transactions WHERE id=?').bind(id).run();
        return json({ ok: true });
      }

      if (path === '/api/bills' && request.method === 'GET') {
        await ensureBillsSchema(env);

        const month = url.searchParams.get('month');
        const c: string[] = [];
        const p: (string | number)[] = [];
        if (month) {
          c.push('b.bill_month = ?');
          p.push(month);
        }

        const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
        const r = await env.DB.prepare(
          `SELECT b.id,
                  b.card_id,
                  COALESCE(b.bill_month, substr(COALESCE(b.due_date, b.statement_date, date('now')),1,7)) as bill_month,
                  b.statement_date,
                  b.due_date,
                  COALESCE(b.bill_amount, b.amount) as bill_amount,
                  b.min_due,
                  b.source,
                  b.notes,
                  COALESCE(b.status,'pending') as status,
                  c.card_name,c.last4,c.bank
           FROM bills b
           LEFT JOIN cards c ON c.id=b.card_id
           ${w}
           ORDER BY COALESCE(b.due_date,'9999-12-31') ASC, b.id DESC`
        ).bind(...p).all();

        return json(r.results ?? []);
      }

      if (path === '/api/bills' && request.method === 'POST') {
        await ensureBillsSchema(env);

        const b = await parse<any>(request);
        if (!b || !b.card_id || !b.bill_month) {
          return bad('card_id and bill_month are required');
        }

        const cardId = Number(b.card_id);
        const billMonth = String(b.bill_month);
        const statementDate = b.statement_date ?? null;
        const dueDate = b.due_date ?? statementDate ?? `${billMonth}-28`;
        const billAmount = b.bill_amount ?? null;
        const minDue = b.min_due ?? null;
        const source = b.source ?? null;
        const notes = b.notes ?? null;

        const existing = await env.DB.prepare(
          `SELECT id FROM bills WHERE card_id = ? AND COALESCE(bill_month, substr(COALESCE(due_date, statement_date, date('now')),1,7)) = ? LIMIT 1`
        ).bind(cardId, billMonth).first<any>();

        if (existing?.id) {
          await env.DB.prepare(
            `UPDATE bills
             SET statement_date=?, due_date=?, bill_amount=?, min_due=?, source=?, notes=?, amount=COALESCE(?, amount), bill_name=COALESCE(bill_name, 'Credit Card Bill'), updated_at=CURRENT_TIMESTAMP
             WHERE id=?`
          ).bind(statementDate, dueDate, billAmount, minDue, source, notes, billAmount, Number(existing.id)).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO bills (card_id,bill_month,statement_date,due_date,bill_amount,min_due,source,notes,bill_name,amount,status,updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Credit Card Bill', ?, 'pending', CURRENT_TIMESTAMP)`
          ).bind(cardId, billMonth, statementDate, dueDate, billAmount, minDue, source, notes, billAmount).run();
        }

        return json({ ok: true });
      }

      if (path.startsWith('/api/bills/') && request.method === 'PATCH') {
        await ensureBillsSchema(env);

        const id = Number(path.split('/').pop());
        if (!id) return bad('Invalid bill id');

        const b = await parse<any>(request);
        if (!b) return bad('Invalid payload');

        const status = b.status ?? null;
        const notes = b.notes ?? null;
        const paidAmount = b.paid_amount ?? null;
        const paidDate = b.paid_date ?? null;

        await env.DB.prepare(
          `UPDATE bills
           SET status = COALESCE(?, status),
               notes = COALESCE(?, notes),
               paid_amount = COALESCE(?, paid_amount),
               paid_date = COALESCE(?, paid_date),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(status, notes, paidAmount, paidDate, id).run();

        return json({ ok: true });
      }

      if (path.startsWith('/api/bills/') && request.method === 'DELETE') {
        await ensureBillsSchema(env);

        const id = Number(path.split('/').pop());
        if (!id) return bad('Invalid bill id');
        await env.DB.prepare('DELETE FROM bills WHERE id=?').bind(id).run();
        return json({ ok: true });
      }

      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Unknown error' }, 500);
    }
  },
};
