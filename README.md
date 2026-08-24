# Merchant Retention App

Internal tool for the EasyStore Success & Activation team.
Tracks churned and at-risk merchants, and gives each account manager a daily
outreach queue with ready-to-send WhatsApp and email messages.

## What is in here

| File | What it is |
|---|---|
| `index.html` | The app itself. One file, opens in any browser. |
| `sync/sync.js` | Pulls merchant data from the console into the database. |
| `.github/workflows/sync.yml` | Runs the sync automatically every 4 hours. |

## Setup (one time)

### 1. Turn on GitHub Pages
Settings > Pages > Source: **Deploy from a branch** > Branch: **main**, folder **/ (root)** > Save.
After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.

### 2. Add the database secret
Settings > Secrets and variables > Actions > **New repository secret**

- Name: `DATABASE_URL`
- Value: the Neon connection string (from console.neon.tech > your project > Connect)

### 3. Add the console session cookie (for the sync)

The console signs in with Google, so the automated job needs a copy of your
session to read the churn report. To get it:

1. Open **console.easystore.pink** and make sure you are signed in
2. Press **F12** (or right-click > Inspect) to open developer tools
3. Go to the **Network** tab, then refresh the page
4. Click the first request in the list (`churn` or similar)
5. Under **Request Headers**, find the line starting `Cookie:`
6. Copy everything after `Cookie: `

Add it as a repository secret named **`CONSOLE_COOKIE`**.

**This cookie expires** — usually after a few weeks. When it does, the sync fails
with "Console session expired" and you repeat the steps above. You will see the
failure in the Actions tab, and the app keeps working on the last synced data in
the meantime.

*A permanent alternative:* if the console team can issue a long-lived API token or
service account, that would remove the re-pasting. Not required to get started.

## Who can log in

Access is controlled by the `allowed_users` table in the database.
To add a colleague:

```sql
INSERT INTO allowed_users (email, am_name)
VALUES ('their.name@easystore.co', 'Their Name');
```

They then sign up in the app with that same email address. Anyone whose email is
not in that table can sign up but will see nothing — no merchant data is returned.

## Notes

- Merchant phone numbers and emails are personal data. Do not export them or
  paste them into other tools.
- The sync writes to `merchants`. Account managers' own updates live in
  `merchant_status`, so a sync never overwrites someone's work.
