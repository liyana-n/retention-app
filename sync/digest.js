/**
 * Daily Slack digest — one DM per account manager, 9am Malaysia time.
 *
 * Reads from Neon (no spreadsheet involved) and sends each AM only their own
 * merchants. Deliberately short: name + store ID, nothing else.
 *
 * SECRETS REQUIRED
 *   DATABASE_URL       Neon connection string
 *   SLACK_BOT_TOKEN    xoxb-… from your Slack app (needs chat:write)
 *   SLACK_CHANNEL_ID   optional — team roll-up channel
 *
 * AM → Slack mapping lives in the `am_slack` table, so nobody edits code:
 *   INSERT INTO am_slack (am_name, slack_id) VALUES ('Amira Liyana','U0AHEATUYBH');
 */
const { Client } = require('pg');

const MODE = process.argv[2] || 'morning';   // 'morning' or 'afternoon'

async function slackPost(channel, text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const d = await r.json();
  if (!d.ok) console.warn(`Slack error for ${channel}: ${d.error}`);
  return d.ok;
}

function fmt(d) {
  return new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'Asia/Kuala_Lumpur',
  });
}

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log('SLACK_BOT_TOKEN not set — skipping digest.');
    return;
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
  const label = fmt(new Date());

  // Who gets a DM
  const map = {};
  try {
    const r = await db.query('SELECT am_name, slack_id FROM am_slack');
    r.rows.forEach(x => map[x.am_name] = x.slack_id);
  } catch (e) {
    console.warn('No am_slack table yet — nobody will receive a DM.');
  }

  // Churned today, still untouched
  const churnedToday = (await db.query(`
    SELECT m.store_id, m.store_name, m.account_manager
    FROM merchants m
    LEFT JOIN merchant_status s ON s.store_id = m.store_id
    WHERE m.churn_date = $1
      AND COALESCE(s.outreach_status,'not-started') = 'not-started'
      AND COALESCE(s.outcome,'') <> 'Won back'
    ORDER BY m.store_name`, [today])).rows;

  // Renewals coming up in the next 14 days, still open
  const atRisk = (await db.query(`
    SELECT m.store_id, m.store_name, m.account_manager, m.expiry_date
    FROM merchants m
    LEFT JOIN merchant_status s ON s.store_id = m.store_id
    WHERE m.is_expired = false
      AND m.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
      AND COALESCE(s.outcome,'') <> 'Recovered'
    ORDER BY m.expiry_date`)).rows;

  // Still open this month — the backlog
  const backlog = (await db.query(`
    SELECT m.store_id, m.store_name, m.account_manager
    FROM merchants m
    LEFT JOIN merchant_status s ON s.store_id = m.store_id
    WHERE date_trunc('month', m.churn_date) = date_trunc('month', CURRENT_DATE)
      AND COALESCE(s.outreach_status,'not-started') = 'not-started'
      AND COALESCE(s.outcome,'') <> 'Won back'
    ORDER BY m.churn_date`)).rows;

  // Afternoon run only speaks up if something new appeared
  if (MODE === 'afternoon' && !churnedToday.length) {
    console.log('Afternoon: nothing new — staying quiet.');
    await db.end();
    return;
  }

  const ams = {};
  const bucket = am => (ams[am || 'Unassigned'] = ams[am || 'Unassigned'] || { churned: [], risk: [], backlog: [] });
  churnedToday.forEach(r => bucket(r.account_manager).churned.push(r));
  atRisk.forEach(r => bucket(r.account_manager).risk.push(r));
  backlog.forEach(r => bucket(r.account_manager).backlog.push(r));

  const CAP = 10;
  const list = (arr, f) => {
    let s = arr.slice(0, CAP).map(r => '• ' + f(r)).join('\n');
    if (arr.length > CAP) s += `\n_…and ${arr.length - CAP} more in the app_`;
    return s + '\n';
  };
  const name = r => `${r.store_name || 'Store ' + r.store_id} \`#${r.store_id}\``;

  const teamLines = [];
  let sent = 0;

  for (const am of Object.keys(ams).sort()) {
    const b = ams[am];
    const quiet = !b.churned.length && !b.risk.length;
    if (quiet && !b.backlog.length) continue;    // nothing at all — no message

    let msg = `*Daily Retention — ${label}*\n`;
    if (quiet) {
      msg += '\nNo churned or at risk today.\n';
      if (b.backlog.length) msg += `\n*Still open this month (${b.backlog.length})*\n` + list(b.backlog, name);
    } else {
      if (b.churned.length) msg += `\n*Churned (${b.churned.length})*\n` + list(b.churned, name);
      if (b.risk.length)    msg += `\n*At risk (${b.risk.length})*\n` +
        list(b.risk, r => `${name(r)} — renews ${fmt(r.expiry_date)}`);
      if (b.backlog.length) msg += `\n_Still open: ${b.backlog.length} this month_\n`;
    }
    msg += '\nOpen Outreach Queue in the app.';

    teamLines.push(`• ${am} — ${b.churned.length} churned, ${b.risk.length} at risk, ${b.backlog.length} open`);
    if (map[am]) { await slackPost(map[am], msg); sent++; }
    else console.log(`No Slack ID for ${am} — skipped.`);
  }

  if (process.env.SLACK_CHANNEL_ID && teamLines.length) {
    await slackPost(process.env.SLACK_CHANNEL_ID,
      `*Daily Retention — ${label}*\n` + teamLines.join('\n'));
  }

  console.log(`Digest sent to ${sent} account manager(s).`);
  await db.end();
}

main();
