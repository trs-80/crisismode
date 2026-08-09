# Remediation guide walk-through — 2026-08-08

## What this is

CrisisMode ships 17 remediation guides that tell users exactly what to click in a provider console. This checklist verifies each guide against the real console, one platform at a time. Total effort is roughly 51 minutes, but you do not need to do it in one sitting — each platform section stands alone, and progress in this file is never lost.

If a click-path has drifted, the person who finds out is a user in the middle of an incident, following directions that no longer match their screen — catching it here is the whole point. A test fails the build when any guide goes 12 months unverified, so this comes due whether or not you schedule it.

## How to work through it

1. Pick any platform section below and sign in to that console (login hint at the top of the section).
2. For each guide: open the link, read the steps, and check they match what you actually see. You are checking the *directions*, not fixing anything — no console changes are needed, and nothing here mutates your account. Guides labeled **Reference doc:** link to documentation, not a live dashboard — open the console section the doc describes and confirm the steps still match what you see there, not just that the doc page loads.
3. Placeholders in `<angle-brackets>` are intentional — users see them too. Judge whether they are clear.
4. Edit the guide's `**Verdict:**` line:
   - `MATCHES` — the steps work as written.
   - `DIFFERS` — something is off. Add a line starting with `**Notes:**` saying what you saw instead.
     Small drift counts (renamed menu item, moved button) — that is exactly what this catches.
   - `BLOCKED` — don't have an account on a platform? Mark those guides BLOCKED with a one-line reason. They stay unverified on purpose — that is a real gap in coverage, not your failure to finish. Add a line starting with `**Notes:**` with that reason.
   - Leave `PENDING` for anything you skipped. Skipping is fine; re-run `apply` any time.
5. When you have done as much as you want, run:

   ```bash
   pnpm run guides:apply docs/guide-verification/2026-08-08-walkthrough.md
   ```

   Every guide marked MATCHES gets its `verifiedOn` date stamped automatically, and its line here
   is rewritten to `STAMPED <date>` so re-running apply never re-stamps it. 
   DIFFERS guides are listed for a follow-up edit — paste the notes to your AI assistant
   or open an issue; do not stamp them until the guide text is fixed.

---

## Anthropic Console — 3 guides, ~9 min

> Sign in at https://console.anthropic.com with the account your app uses.
>
> **Heads-up:** Observed 2026-08-07: every console.anthropic.com URL redirects to platform.claude.com. While walking these guides, note whether the guide URLs and step wording should adopt the new domain. A working redirect still counts as DIFFERS — record it once per guide and move on; the fix is a URL edit, not a re-walk.

### 1. Rotate your Anthropic API key

Guide id: `anthropic-rotate-key` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/anthropic.ts`

**Open:** https://console.anthropic.com/settings/keys

**Steps users are told to follow:**

1. Open the Anthropic Console and sign in to the workspace your app uses.
2. Go to Settings → API keys → Create Key, and name it after the app and environment (e.g. "myapp-production").
3. Copy the key immediately — the console shows the full value only once.
4. Set ANTHROPIC_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.
5. Return to Settings → API keys and delete the old key only after the new one is live.

**Users are told to expect:** The key check passes on the next `crisismode scan`, and API calls stop returning 401 authentication_error.

**Caution shown to users:** Deleting the old key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

**Verdict:** DIFFERS <!-- guide:anthropic-rotate-key -->
**Notes:** console.anthropic.com now redirects to platform.claude.com (verified live: /settings/keys -> platform.claude.com/login?returnTo=%2Fsettings%2Fkeys; login page branded 'Claude Console' / 'Claude Platform'). Guide URL and 'Anthropic Console' step wording should adopt the new domain/branding. In-console steps NOT verified — this browser is not signed in; needs a logged-in pass.

### 2. Check and raise your Anthropic rate limits

Guide id: `anthropic-rate-limits` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/anthropic.ts`

**Open:** https://console.anthropic.com/settings/limits

**Steps users are told to follow:**

1. Open the Anthropic Console → Settings → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.
2. Compare those limits against the headroom CrisisMode reported — the limit that runs out first is the one to act on.
3. Make the app handle 429 responses by waiting for the number of seconds in the retry-after header instead of retrying immediately.
4. To raise the limits, advance your usage tier by adding credits in Settings → Billing; for sustained higher limits, contact Anthropic sales from the same page.

**Users are told to expect:** Rate-limit headroom stays above 20% during peak traffic and 429 responses stop appearing in application logs.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
curl -s -D - -o /dev/null https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | grep -i anthropic-ratelimit
```

**Verdict:** DIFFERS <!-- guide:anthropic-rate-limits -->
**Notes:** Same platform.claude.com migration as anthropic-rotate-key (redirect verified live). URL/wording fix needed; in-console steps unverified — needs a logged-in pass.

### 3. Restore Anthropic billing or credit balance

Guide id: `anthropic-billing-credits` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/anthropic.ts`

**Open:** https://console.anthropic.com/settings/billing

**Steps users are told to follow:**

1. Open the Anthropic Console → Settings → Billing and check the current credit balance.
2. Confirm the workspace has a valid payment method attached.
3. Buy credits, then enable auto-reload so the balance cannot reach zero mid-incident.
4. Re-run `crisismode scan` to confirm the quota/billing check has cleared.

**Users are told to expect:** API calls stop failing with billing or credit errors, and the quota/billing check reports healthy.

**Verdict:** DIFFERS <!-- guide:anthropic-billing-credits -->
**Notes:** Same platform.claude.com migration as anthropic-rotate-key (redirect verified live). URL/wording fix needed; in-console steps unverified — needs a logged-in pass.

---

## OpenAI Platform — 3 guides, ~9 min

> Sign in at https://platform.openai.com with the account your app uses.

### 1. Rotate your OpenAI API key

Guide id: `openai-rotate-key` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/openai.ts`

**Open:** https://platform.openai.com/api-keys

**Steps users are told to follow:**

1. Open the OpenAI platform API keys page, and check the organization and project selector at the top matches the one your app bills to.
2. Choose Create new secret key, scope it to the project your app uses, and name it after the app and environment.
3. Copy the key immediately — the platform shows the full value only once.
4. Set OPENAI_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.
5. Return to the API keys page and revoke the old key only after the new one is live.

**Users are told to expect:** The key check passes on the next `crisismode scan`, and API calls stop returning 401.

**Caution shown to users:** Revoking a key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
```

**Verdict:** BLOCKED <!-- guide:openai-rotate-key -->
**Notes:** platform.openai.com/login reached with next=%2Fapi-keys preserved (path exists behind auth; no domain change). Not signed in in this browser — needs a logged-in pass.

### 2. Check OpenAI usage tier and rate limits

Guide id: `openai-usage-limits` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/openai.ts`

**Open:** https://platform.openai.com/settings/organization/limits

**Steps users are told to follow:**

1. Open Settings → Organization → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.
2. Distinguish the two 429 causes: an `insufficient_quota` error means the organization is out of credit (see the billing guide), while a plain rate-limit 429 means you are sending too fast.
3. Make the app wait for the retry-after header on 429 responses rather than retrying immediately.
4. Raise the monthly budget or usage limit on the same page if the ceiling is a budget cap rather than a tier limit.

**Users are told to expect:** Rate-limit headroom stays above 20% during peak traffic and 429 responses stop.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
curl -s -D - -o /dev/null https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | grep -i x-ratelimit
```

**Verdict:** BLOCKED <!-- guide:openai-usage-limits -->
**Notes:** Login page reached, path preserved. Not signed in — needs a logged-in pass.

### 3. Restore OpenAI billing or credit balance

Guide id: `openai-billing` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/openai.ts`

**Open:** https://platform.openai.com/settings/organization/billing/overview

**Steps users are told to follow:**

1. Open Settings → Organization → Billing → Overview and check the credit balance and payment method.
2. Add to the credit balance, then enable auto-recharge so the balance cannot reach zero mid-incident.
3. Check that the project your key belongs to has not hit its own budget limit under Settings → Project → Limits.
4. Re-run `crisismode scan` to confirm the quota/billing check has cleared.

**Users are told to expect:** Calls stop failing with `insufficient_quota`, and the quota/billing check reports healthy.

**Verdict:** BLOCKED <!-- guide:openai-billing -->
**Notes:** Login page reached, path preserved. Not signed in — needs a logged-in pass.

---

## Supabase Dashboard — 4 guides, ~12 min

> Sign in at https://supabase.com/dashboard and open the project your app uses.

### 1. Use the Supabase transaction pooler for serverless functions

Guide id: `supabase-pooler-mode` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/supabase.ts`

**Open:** https://supabase.com/dashboard/project/_/settings/database

**Steps users are told to follow:**

1. Open the Supabase dashboard → your project → Project Settings → Database → Connection string.
2. Pick the Transaction pooler connection string (port 6543) for serverless or edge deployments, where every invocation opens its own connection.
3. Keep the Session pooler or direct connection (port 5432) for long-lived servers and for migrations.
4. Set DATABASE_URL to the transaction-pooler URI in the serverless deployment and redeploy.
5. If your Postgres driver uses prepared statements by default, disable them for the pooled connection (for example `?pgbouncer=true` or the driver's prepared-statement flag).

**Users are told to expect:** DATABASE_URL points at the pooler host on port 6543, and `crisismode readiness` no longer flags serverless-pooling.

**Caution shown to users:** Transaction mode does not support session-level features (LISTEN/NOTIFY, session-scoped prepared statements, advisory locks held across statements). Run migrations over the direct connection.

**Verdict:** BLOCKED <!-- guide:supabase-pooler-mode -->
**Notes:** Dashboard session expired (redirects to /dashboard/sign-in with returnTo preserved). Observed en route: /project/_/settings/database now redirects to /project/_/database/settings (path rename; guide URL still works via redirect). Needs a logged-in pass.

### 2. Fit your app inside the Supabase connection cap

Guide id: `supabase-connection-limits` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/supabase.ts`

**Reference doc:** https://supabase.com/docs/guides/platform/compute-and-disk

**Steps users are told to follow:**

1. Open the Supabase dashboard → Project Settings → Database → Connection pooling to see the pool size and maximum client connections for your compute size.
2. Compare that ceiling against the connection count CrisisMode reported — count every running instance, not just one.
3. Lower the per-instance pool size in the app so (instances × pool size) stays under the cap with room to spare.
4. Move serverless traffic to the transaction pooler so short invocations share connections instead of each holding one.
5. If the cap is genuinely too small for the workload, upgrade compute (see the compute upgrade guide).

**Users are told to expect:** Peak connection count stays below the cap, and connection-headroom reports ready.

**Verdict:** BLOCKED <!-- guide:supabase-connection-limits -->
**Notes:** Reference doc verified current: the compute-and-disk page carries the 'Compute instance connection limits' table with Database Max Connections and Connection Pooler Max Clients columns — exactly what the steps rely on. Dashboard steps unverified — session expired; needs a logged-in pass.

### 3. Upgrade Supabase compute for a higher connection limit

Guide id: `supabase-upgrade-compute` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/supabase.ts`

**Open:** https://supabase.com/dashboard/project/_/settings/compute-and-disk

**Steps users are told to follow:**

1. Open the Supabase dashboard → Project Settings → Compute and Disk.
2. Read the current compute size and the connection limits documented for each size.
3. Select the next compute size up and confirm the change.
4. Wait for the restart to finish, then re-run `crisismode readiness` to confirm the new headroom.

**Users are told to expect:** The reported maximum connections rises to the new compute size's limit.

**Caution shown to users:** Changing compute size restarts the database — connections drop for seconds to minutes. Larger compute bills at a higher hourly rate.

**Verdict:** BLOCKED <!-- guide:supabase-upgrade-compute -->
**Notes:** Session expired. Note for the logged-in pass: PR #107's liveness check saw /settings/compute-and-disk redirect to /settings/infrastructure — confirm whether the menu is still named 'Compute and Disk'.

### 4. Add an approximate vector index to your pgvector table

Guide id: `supabase-pgvector-index` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/supabase.ts`

**Reference doc:** https://supabase.com/docs/guides/database/extensions/pgvector

**Steps users are told to follow:**

1. Open the Supabase dashboard → SQL Editor.
2. Confirm the table and vector column named in the readiness finding.
3. Create an HNSW index whose operator class matches the distance function your queries use, e.g. `CREATE INDEX CONCURRENTLY ON items USING hnsw (embedding vector_cosine_ops);`.
4. For an existing ivfflat index the report flagged, either recreate it with `lists` close to sqrt(row count) or replace it with an HNSW index.
5. Run `EXPLAIN ANALYZE` on a representative similarity query and confirm it now uses an index scan.

**Users are told to expect:** EXPLAIN ANALYZE shows an index scan instead of a sequential scan, and the vector readiness rule reports ready.

**Caution shown to users:** Building the index on a large table takes time and IO; CONCURRENTLY avoids blocking writes but takes longer. If the operator class does not match the distance operator the query uses (vector_cosine_ops / vector_l2_ops / vector_ip_ops), the planner ignores the index.

**Verdict:** DIFFERS <!-- guide:supabase-pgvector-index -->
**Notes:** Wrong Reference doc: /docs/guides/database/extensions/pgvector contains no HNSW creation or operator-class guidance (indexes appear only in a query-filtering caveat). The content the steps teach lives at /docs/guides/ai/vector-indexes/hnsw-indexes — verified live: CREATE INDEX USING hnsw examples for vector_l2_ops, vector_ip_ops, and vector_cosine_ops. Swap the url field. SQL Editor steps unverified — session expired.

---

## Neon Console — 2 guides, ~6 min

> Sign in at https://console.neon.tech (may redirect to neon.com) and open the project your app uses.
>
> **Heads-up:** Neon guide URLs point at neon.com while the console login hint points at console.neon.tech. Confirm which domain is current for your account, and record DIFFERS on any guide whose URL should change.

### 1. Switch Neon to the pooled connection endpoint

Guide id: `neon-pooled-connection` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/neon.ts`

**Reference doc:** https://neon.com/docs/connect/connection-pooling

**Steps users are told to follow:**

1. Open the Neon console → your project → Dashboard → Connect (Connection Details).
2. Enable the connection pooling option — the host in the connection string gains a `-pooler` suffix.
3. Set DATABASE_URL to the pooled connection string in the serverless deployment and redeploy.
4. Keep the unpooled (direct) connection string for migrations and for anything that needs a session-scoped feature.

**Users are told to expect:** DATABASE_URL's host ends in `-pooler`, and `crisismode readiness` no longer flags serverless-pooling.

**Caution shown to users:** The pooled endpoint runs PgBouncer in transaction mode: session-level features and some prepared-statement modes are unavailable. Run migrations over the direct endpoint.

**Verdict:** BLOCKED <!-- guide:neon-pooled-connection -->
**Notes:** Reference doc verified current: '-pooler' hostname suffix and PgBouncer transaction mode ('Neon uses PgBouncer in transaction mode', pool_mode=transaction) both documented. Domain question resolved: docs live on neon.com; console login is at console.neon.tech (no redirect; verified live) — no URL change needed. Console steps unverified — not signed in.

### 2. Raise Neon compute size to lift the connection limit

Guide id: `neon-compute-size` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/neon.ts`

**Reference doc:** https://neon.com/docs/introduction/autoscaling

**Steps users are told to follow:**

1. Open the Neon console → your project → Settings → Compute.
2. Read the autoscaling minimum and maximum compute units — Postgres max_connections scales with compute size, so a small minimum caps connections even when traffic is low.
3. Raise the minimum (and, if needed, the maximum) compute units, then save.
4. If the workload is bursty and serverless, prefer the pooled endpoint over larger compute — it is cheaper for the same connection count.
5. Re-run `crisismode readiness` to confirm the new headroom.

**Users are told to expect:** The reported maximum connections rises, and connection-headroom reports ready.

**Caution shown to users:** Compute bills by the hour: the autoscaling minimum sets your floor cost and the maximum sets the ceiling.

**Verdict:** BLOCKED <!-- guide:neon-compute-size -->
**Notes:** Reference doc live and topical (autoscaling overview; min/max CU configuration one click deeper at 'Configure autoscaling'). The step-2 claim that max_connections scales with compute size is NOT on this page — it is documented on the connection-pooling doc; consider citing that page in the step. Console steps unverified — not signed in.

---

## AWS Console (RDS) — 4 guides, ~12 min

> Sign in at https://console.aws.amazon.com and switch to the region your resources live in.

### 1. Increase allocated storage on RDS instance <instance>

Guide id: `aws-rds-increase-storage` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/aws-rds.ts`

**Open:** https://console.aws.amazon.com/rds/

**Steps users are told to follow:**

1. Open the RDS console → Databases → <instance>.
2. Choose Modify → Allocated storage and raise it to <target-storage-gb> GiB.
3. Choose Apply immediately to take effect now, or leave it for the next maintenance window.

**Users are told to expect:** Free storage rises above the threshold and the instance returns to available.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
aws rds modify-db-instance --db-instance-identifier <instance> --allocated-storage <target-storage-gb> --apply-immediately
```

**Verdict:** BLOCKED <!-- guide:aws-rds-increase-storage -->
**Notes:** AWS IAM sign-in page reached (region-pinned us-east-2 in this browser). Not signed in — needs a logged-in pass.

### 2. Reduce connection saturation on RDS instance <instance>

Guide id: `aws-rds-connection-saturation` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/aws-rds.ts`

**Open:** https://console.aws.amazon.com/rds/

**Steps users are told to follow:**

1. Open the RDS console → Databases → <instance>.
2. Either put connection pooling in front of the database (RDS Proxy), or choose Modify → DB instance class and select a larger class.

**Users are told to expect:** Connection count settles well below the instance limit.

**Caution shown to users:** Applying a class change reboots the instance immediately — schedule during low traffic, or omit --apply-immediately to wait for the next maintenance window.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
aws rds modify-db-instance --db-instance-identifier <instance> --db-instance-class <larger-class> --apply-immediately
```

**Verdict:** BLOCKED <!-- guide:aws-rds-connection-saturation -->
**Notes:** Not signed in to the AWS console — needs a logged-in pass.

### 3. Open RDS security group ingress on instance <instance>

Guide id: `aws-rds-open-security-group` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/aws-rds.ts`

**Open:** https://console.aws.amazon.com/ec2/

**Steps users are told to follow:**

1. Open the EC2 console → Security Groups → <security-group-id>.
2. Choose Inbound rules → Edit inbound rules, and allow TCP port <db-port> with your application's security group as the source.

**Users are told to expect:** The application can open connections to the database again.

**Caution shown to users:** Use the application's security group as the source. Opening the database port to 0.0.0.0/0 exposes it to the internet.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
aws ec2 authorize-security-group-ingress --group-id <security-group-id> --protocol tcp --port <db-port> --source-group <app-security-group-id>
```

**Verdict:** BLOCKED <!-- guide:aws-rds-open-security-group -->
**Notes:** Not signed in to the AWS console — needs a logged-in pass.

### 4. Bring RDS instance <instance> back to available

Guide id: `aws-rds-instance-not-available` · last verified 2026-08-05 · defined in `src/framework/guidance/guides/aws-rds.ts`

**Open:** https://console.aws.amazon.com/rds/

**Steps users are told to follow:**

1. Open the RDS console → Databases → <instance> and read the current status and status reason.
2. Check Logs & events → Recent events for what changed.
3. If the status is 'stopped', choose Actions → Start.
4. If the status is 'rebooting' or maintenance is in progress, wait and monitor — no action is needed unless it fails to return to 'available'.
5. Otherwise, review recent events and contact AWS support if the instance does not return to 'available'.

**Users are told to expect:** Instance status returns to 'available' and clients can connect.

**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):

```bash
aws rds describe-db-instances --db-instance-identifier <instance> (then, if stopped: aws rds start-db-instance --db-instance-identifier <instance>)
```

**Verdict:** BLOCKED <!-- guide:aws-rds-instance-not-available -->
**Notes:** Not signed in to the AWS console — needs a logged-in pass.

---

## Third-party status pages — 1 guide, ~3 min

> No login required — these steps walk a public status page, not an account-specific console.

### 1. Confirm and respond to a third-party dependency incident

Guide id: `dependency-incident-response` · last verified 2026-08-08 · defined in `src/framework/guidance/guides/service-status.ts`

**Steps users are told to follow:**

1. Open the status page for <service> (e.g. https://status.<provider>.com) and confirm it lists an incident matching what CrisisMode observed.
2. Subscribe to updates on that status page (email, RSS, or a Slack/webhook integration) so the team hears about resolution without polling.
3. Do not ship debugging changes, redeploys, or config edits against your own systems while the incident is confirmed upstream — nothing in your app or infrastructure caused it, and changes made now are likely to get blamed for the outage's after-effects.
4. Check your app's error handling for calls to <service>: does it retry with backoff, fail gracefully, and surface a clear error, rather than crashing or hanging the request?
5. Note the incident-history URL for <service> (e.g. https://status.<provider>.com/history) so a future occurrence can be checked against this one.

**Users are told to expect:** The provider's status page confirms resolution, and CrisisMode's next scan reports the status-page and reachability checks for <service> healthy again.

**Caution shown to users:** This is the provider's incident, not yours to fix — resist the urge to redeploy or roll back your own service while it is open.

**Verdict:** STAMPED 2026-08-08 <!-- guide:dependency-incident-response -->

---

_Generated from the live guide registry by `pnpm run guides:walkthrough`. Regenerate rather than hand-editing guide content here; only the Verdict and Notes lines are yours._
