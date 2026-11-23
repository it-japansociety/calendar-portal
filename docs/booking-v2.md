# Booking Workflow v2 — developer notes

Requesters book spaces in this portal's own UI; JotForm stays the system of
record behind it. One booking = one `event_groups` row = many per-day JotForm
submissions, fanned out by a durable queue.

The stakeholder-facing scope document (features, roles, lifecycle, rollout) is
maintained separately as a shared artifact. This file is for whoever runs or
extends the code.

---

## Request flow

```
/submit ──POST /api/groups──> event_groups + N submission_jobs   (one D1 batch, returns instantly)
                                     │
                    POST /api/queue/drain (kicked on create, cron in P2)
                                     │
                      live_mode=0 ──> local mirror rows in `events`   (dev stage)
                      live_mode=1 ──> JotForm create/edit via src/lib/jotform-client.ts
                                     │
                     sync (existing nightly-sync.yml) ──> `events` mirrors JotForm
                                     │
              rules engine (src/lib/rules.ts) ──> auto-confirm / flags ──> rule_actions
```

`group_id` is the join key everywhere: `events.group_id`, `function_forms.group_id`,
`submission_jobs.group_id`, and (in P3) the Salesforce external ID.

## Tables (migration `0003_workflow.sql`)

| Table | Holds |
|---|---|
| `event_groups` | the booking as the requester experiences it (fields entered once + range spec + status rollup) |
| `submission_jobs` | the durable queue — one row per (group, form, action, date); `UNIQUE` on that tuple is the idempotency guarantee |
| `function_forms` | one row per group, `data` = JSON of `FunctionFormData`, `complete` gates auto-confirm |
| `rule_actions` | audit + undo log for every automated and admin action |
| `settings` | `live_mode`, `email_enabled`, rule thresholds — editable in `/admin` |

`events` gains `group_id`. Fresh databases get it from the migration; existing
ones from the guarded `ALTER` in the import route (same pattern as
`submitted_at` in 0002).

## Dry-run semantics (the dev stage)

`settings.live_mode = '0'` means **nothing leaves the building**:

- `create` jobs mark themselves done with `jotform_id = 'dryrun-<group8>-<date>'`
  and insert a mirror row into `events`, so bookings appear on the real calendar
  and availability views locally.
- `edit` jobs update those mirror rows; `release` jobs set them to `Released`.
- The rules engine logs every action it *would* take to `rule_actions` with
  `dry_run = 1`; admin Confirm/Release still move the local mirror rows so the
  console is walkable.
- No email code path runs at all (`email_enabled = '0'`).

Flipping `live_mode` to `'1'` is what makes the queue call JotForm. Do that only
on staging against **cloned** forms (see below).

## Running locally

```bash
npm run dev
```

Then seed the local D1 (idempotent, ~40s — pulls every JotForm submission):

```bash
curl -X POST http://localhost:3000/api/import \
  -H "Authorization: Bearer $JOTFORM_API_KEY" \
  -H "Content-Type: application/json" -d '{"dry_run": false}'
```

Local identity: Cloudflare Access isn't in front of localhost, so
`src/lib/identity.ts` falls back to a dev email and honours `?as=` on any page
or API call (`/my?as=someone@japansociety.org`). **That override is dev-only —
it must never be trusted once Access fronts the routes.**

Useful calls while developing:

```bash
curl -X POST http://localhost:3000/api/queue/drain -d '{}'          # drain now
curl -X POST http://localhost:3000/api/rules/run  -d '{"dry_run":true}'
curl http://localhost:3000/api/admin/queue                           # console data
```

## Client conventions

- **Caching**: every page's mount fetch goes through `cachedFetch` in
  `src/lib/client-cache.ts` (stale-while-revalidate over `sessionStorage`), so a
  return visit paints from cache and swaps in fresh data. Mutations call
  `invalidateCache(key)`. Keys in use: `my-groups`, `admin-queue`, `settings`,
  `ff:<groupId>`.
- **Theme**: system-synced only. `useTheme()` in `src/components/Shell.tsx`
  reads `prefers-color-scheme`, toggles `.dark` on `<html>`, and tracks live OS
  changes. There is no manual toggle to maintain.
- **Design system**: glass surfaces and Fluent-style controls live in
  `globals.css` — `.v2-bg`, `.glass`, `.glass-strong`, `.v2-input`,
  `.v2-btn-primary`, `.v2-btn-ghost`, `.v2-kicker`. Use these rather than
  ad-hoc styling so the pages stay one system.
- **Copy**: English only on v2 pages.

## Function form

`FunctionFormData` in `src/lib/workflow-types.ts` mirrors the box office's paper
Function Form section by section. The defining rule: **anything the booking
already knows is displayed read-only, never re-asked** (title, dates, times,
rooms, department, contact). `FUNCTION_FORM_MAX` carries the paper form's
equipment maxima (mics 4, whiteboards 2, stanchions 5 …) and the UI enforces
them.

Completeness = `staff_in_charge` + `guest_count`. That's what arms auto-confirm.

The JotForm side of this form does not exist yet — `FUNCTION_FORM_ID` in
`src/lib/jotform-client.ts` is empty, so live fan-out skips it and the console
shows "not configured". When the box office creates it, set the id and add a
hidden `group_id` field to the form.

## Adding a rule

Rules live in `src/lib/rules.ts` and follow one shape: read thresholds from
`settings`, evaluate, return action objects, insert non-duplicate ones into
`rule_actions`. Two invariants:

1. **Never override a human.** Auto-confirm only ever moves `Pending →
   Confirmed`; anything a person set in JotForm wins.
2. **Everything is undoable.** Write `before_status`/`after_status` so
   `/api/admin/action {action:'undo'}` can reverse it.

## P2 staging cutover (not done yet)

1. `staging` branch + Cloudflare git integration; prod deploys only from `main`.
2. `wrangler.jsonc`: a `staging` environment with its own Worker name and D1
   (`calendar-portal-db-staging`), plus a cron trigger for the queue drain.
3. Clone the event form in JotForm (and create the function form) as **test**
   forms; point staging's `EVENT_FORM_ID`/`FUNCTION_FORM_ID` at the clones.
4. Add a staging variant of `nightly-sync.yml` against the test forms.
5. Entra app registration for Graph `Mail.Send`, scoped by
   ApplicationAccessPolicy to `boxoffice@japansociety.org`; secret as a Worker
   secret. Staging sends only to an IT address.
6. Only then flip `live_mode = '1'` on staging and run the end-to-end drill:
   2-day booking → JotForm rows + receipt → function form → auto-confirm +
   confirmation email → undo → cancel → cleanup.

## Security notes carried into P2

- `workers.dev` currently bypasses Cloudflare Access and serves everything.
  Before v2 goes live: validate `Cf-Access-Jwt-Assertion` server-side on every
  mutating route **and** set `workers_dev: false`.
- `isAdmin()` in `src/lib/identity.ts` is a hardcoded list — replace with an
  Access group check.
- Rotate `JOTFORM_API_KEY`; a copy sits in plaintext in a OneDrive script
  (`Jotform - Access Database/house_calendar_export.py`).
