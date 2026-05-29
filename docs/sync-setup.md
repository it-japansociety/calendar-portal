# Calendar Sync — Setup

The **Calendar Sync** GitHub Actions workflow (`.github/workflows/nightly-sync.yml`)
runs on a schedule and POSTs to `/api/import` on the Cloudflare Worker, which pulls
new JotForm submissions into the D1 database.

The Worker is protected by **Cloudflare Access (Zero Trust SSO)**. A human visiting
the site logs in via SSO, but an automated job has no SSO session — so the request
gets `302`-redirected to the login page and the sync fails. To let the job through,
it authenticates with a **Cloudflare Access service token**.

This is a one-time setup. Once done, the sync runs automatically.

---

## Step 1 — Create a service token (Cloudflare Zero Trust)

1. Go to the **Zero Trust dashboard** → **Access** → **Service Auth** → **Service Tokens**.
2. Click **Create Service Token**.
3. Name it `github-actions-sync`.
4. Copy the **Client ID** and **Client Secret** now — the secret is shown only once.

## Step 2 — Allow the token on the Access application

1. Zero Trust → **Access** → **Applications**.
2. Open the application that protects the calendar portal
   (hostname `calendar-portal.japan-society-account.workers.dev`).
3. **Policies** → **Add a policy**:
   - **Action:** `Service Auth`
   - **Include:** selector `Service Token` → choose `github-actions-sync`
4. Save.

> If the Access application is defined on the custom domain
> (`calendar.japansociety.org`) instead of the `workers.dev` hostname, either add the
> policy to that application and change the URL in the workflow to the custom domain,
> or ensure the `workers.dev` hostname is covered by an application that has this policy.

## Step 3 — Add the token to GitHub repo secrets

In the GitHub repo: **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add both:

| Secret name | Value |
|---|---|
| `CF_ACCESS_CLIENT_ID` | Client ID from Step 1 |
| `CF_ACCESS_CLIENT_SECRET` | Client Secret from Step 1 |

`JOTFORM_API_KEY` is already set and stays — it's the JotForm API key the import
route uses to fetch submissions.

## Step 4 — Verify

1. GitHub repo → **Actions** tab → **Calendar Sync** → **Run workflow**.
2. Open the run log. The response should show HTTP `200` and a JSON body like
   `{"inserted": N, ...}` instead of a `302`.

---

## Alternative: bypass Access on the API path (simpler, no GitHub secrets)

Instead of a service token, you can add a **Bypass** policy scoped only to the
`/api/import` (and `/api/webhook`) path. Those endpoints are already protected by the
bearer API key / webhook token in the app code, so bypassing SSO on just those paths
is reasonable. If you do this, the `CF-Access-*` headers in the workflow are simply
ignored — no GitHub secrets required.

## Note on schedule frequency

The cron is `*/15 * * * *` (every 15 min), but GitHub throttles high-frequency
scheduled workflows on shared runners, so in practice it fires roughly every
1–3 hours. The workflow uses a 2-hour `since_date` lookback window, so overlapping
runs just re-upsert the same rows harmlessly and nothing is missed.
