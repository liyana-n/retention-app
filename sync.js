/**
 * Pulls churned merchants from the EasyStore console into Neon.
 * Runs every 4 hours via GitHub Actions. Nothing else required — no engineering
 * team, no server. GitHub runs it, Neon stores it.
 *
 * HOW IT WORKS
 *   1. Fetches the monthly churn report page (server-rendered HTML) and pulls
 *      every store ID out of it.
 *   2. For each store, calls /@api/v2/stores/{id}/insight — this one IS JSON and
 *      returns name, contacts, account manager, plan and expiry in a single call.
 *   3. Upserts into `merchants`. Account managers' own work lives in
 *      `merchant_status`, which this never touches.
 *
 * REPOSITORY SECRETS REQUIRED
 *   DATABASE_URL    Neon connection string
 *   CONSOLE_COOKIE  Your console session cookie (see README for how to copy it)
 */
const { Client } = require('pg');

const CONSOLE = 'https://console.easystore.pink';
const REGION  = 'z1';

function headers() {
  return {
    'Accept': 'text/html,application/json',
    'Cookie': process.env.CONSOLE_COOKIE || '',
    'User-Agent': 'retention-sync',
  };
}

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function planParts(code) {
  const p = String(code || '').toLowerCase().replace(/^(myr|sgd)-/, '');
  return {
    tier: (p.split('-')[0] || '').replace(/^./, c => c.toUpperCase()),
    cycle: p.includes('trienn') ? '3years'
         : p.includes('bienn')  ? '2years'
         : p.includes('year')   ? 'yearly'
         : 'monthly',
  };
}

function pickContact(users) {
  if (!Array.isArray(users) || !users.length) return { email: '', phone: '' };
  const owner = users.find(u => u.role === 'owner');
  const withPhone = users.find(u => u.phone && String(u.phone).trim());
  return {
    email: String((owner && owner.email) || users[0].email || '').trim(),
    phone: String((owner && owner.phone) || (withPhone && withPhone.phone) || '').trim(),
  };
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  let synced = 0, added = 0, status = 'ok', message = '';

  try {
    if (!process.env.CONSOLE_COOKIE) {
      throw new Error('CONSOLE_COOKIE secret is not set — see README.');
    }

    // 1. Churn report page → store IDs
    const reportUrl = `${CONSOLE}/reports/retention/churn?date_group=${thisMonth()}&region=${REGION}`;
    const res = await fetch(reportUrl, { headers: headers() });
    if (!res.ok) throw new Error(`Churn report returned ${res.status}`);
    const html = await res.text();

    // If the cookie has expired the console serves a login page instead
    if (/sign in|log in|<form[^>]+login/i.test(html) && !/\/stores\/\d+/.test(html)) {
      throw new Error('Console session expired — refresh the CONSOLE_COOKIE secret.');
    }

    const ids = [...new Set(
      [...html.matchAll(/\/stores\/(\d+)/g)].map(m => m[1])
    )];
    if (!ids.length) throw new Error('No stores found in the churn report — page format may have changed.');
    console.log(`Churn report lists ${ids.length} stores.`);

    // 2. Store detail, a few at a time so we do not hammer the console
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const details = await Promise.all(batch.map(async id => {
        try {
          const r = await fetch(`${CONSOLE}/@api/v2/stores/${id}/insight`, { headers: headers() });
          if (!r.ok) return { id, err: `HTTP ${r.status}` };
          return { id, data: await r.json() };
        } catch (e) {
          return { id, err: e.message };
        }
      }));

      for (const d of details) {
        if (d.err) { console.warn(`store ${d.id}: ${d.err}`); continue; }
        const store   = d.data.store || {};
        const contact = pickContact(d.data.users);
        const sub     = (d.data.subscriptions && d.data.subscriptions[0]) || {};
        const plan    = planParts(sub.bt_plan_id);
        const expiry  = store.expired_at ? String(store.expired_at).slice(0, 10) : null;
        const expired = expiry ? new Date(expiry) < new Date() : false;

        const seen = await db.query('SELECT 1 FROM merchants WHERE store_id=$1', [d.id]);
        if (!seen.rowCount) added++;

        await db.query(
          `INSERT INTO merchants
             (store_id, store_name, email, phone, account_manager,
              plan_tier, plan_cycle, expiry_date, churn_date, is_expired, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10, now())
           ON CONFLICT (store_id) DO UPDATE SET
             store_name      = EXCLUDED.store_name,
             email           = EXCLUDED.email,
             phone           = EXCLUDED.phone,
             account_manager = EXCLUDED.account_manager,
             plan_tier       = EXCLUDED.plan_tier,
             plan_cycle      = EXCLUDED.plan_cycle,
             expiry_date     = EXCLUDED.expiry_date,
             churn_date      = COALESCE(merchants.churn_date, EXCLUDED.churn_date),
             is_expired      = EXCLUDED.is_expired,
             synced_at       = now()`,
          [
            d.id,
            store.name || '',
            contact.email || store.customer_email || '',
            contact.phone || '',
            (d.data.account_manager && d.data.account_manager.name) || '',
            plan.tier, plan.cycle, expiry, expiry, expired,
          ]
        );
        synced++;
      }
    }
  } catch (e) {
    status = 'error';
    message = e.message;
    console.error('Sync failed:', e.message);
  }

  await db.query(
    'INSERT INTO sync_log (merchants, new_churns, status, message) VALUES ($1,$2,$3,$4)',
    [synced, added, status, message]
  );
  await db.end();

  console.log(`Sync ${status}: ${synced} synced, ${added} new.`);
  if (status === 'error') process.exit(1);
}

main();
