# HANDOFF — Local posts (BEL) workspace build

**Date left off:** 2026-09-05
**Branch:** working tree, **nothing committed** (all changes uncommitted)
**Source of truth:** `Réglement - Septembre 2026 (Sans design).pdf` (Statut + Règlement intérieur + Annexe du système de mise à jour)

---

## 1. Why this work started

Task given: *"check everything about every single role and start working on them. leave a place for editing any report cuz it will be on a separate page and imma give you every report you need. i want the space for the local posts to be complete and then we will do stronger stuff."*

So the scope is **the local posts (BEL) only** — national/AG work is explicitly deferred ("stronger stuff" later).

---

## 2. Audit result — the 6 BEL posts

The règlement (RI I.1.12) seats **six** posts on every Bureau Exécutif Local. State when I started:

| Post | Doc article | Page | State found |
|---|---|---|---|
| Président Local | RI I.4.2 | `president.html` | ~35% — shell, 3 of 5 tabs render permanently empty |
| Secrétaire Général Local | RI I.5.2 | `secretariat.html` | ~90% — best built page |
| Trésorier Local | RI I.6.2 | `tresorerie.html` | **was 100% dead** (fixed earlier in session, see §6) |
| **VPI** | RI I.7.2 | **none** | **0% — no page, no nav, no access flag, no tables** |
| **VPE** | RI I.8.2 | **none** | **0%** |
| **VPC** | RI I.9.2 | **none** | **0%** |
| SupCo Local (3 members) | RI II.1.6 | `supervision.html` | ~95% but had **no `supco_local` display role** |

Other findings:
- `reports.html` was **hard-broken** — raw HTML pasted inside a `<script>` block → `SyntaxError: Unexpected token '<'`, killing all page interactivity.
- `responsibilities.html` is an **orphan** — functional but zero inbound links anywhere in the repo.

---

## 3. Bugs found and fixed (real spec violations, not cosmetics)

1. **Membership approval was assigned to the VPC.** `roles.js` let the club's **VPC** approve adhésions in 3 places. The règlement gives local recruitment to the **VPI** (RI I.7.2.1 "Assurer le recrutement des nouveaux adhérents"; RI I.7.7.2 the VPI sets recruitment criteria, the parrains' evaluation criteria and the trial period). VPC is communication only (RI I.9.2).
   → switched all 3 to `vpi`.
   > **⚠ BEHAVIOUR CHANGE / ACTION NEEDED:** any club currently relying on its VPC to approve membership will lose that ability. Give those people an explicit `membership_approver` capability grant via `admin-roles.html`.

2. **BEL officers were locked out of their own club work.** `canViewClubWork` / `canCreateReport` were capability-only, so a freshly elected VPE/VPC/VPI with no grants saw *"réservé aux responsables désignés"* — while `api/portal.js`'s own `reports()` guard (`getCurrentDisplayRole(...) || hasCapability(...)`) would happily accept them. Frontend and backend disagreed. Fixed by honouring the display role in `getMemberPortalAccess`.

3. **`tresorerie.html` was entirely dead** (fixed earlier in this session) — every backtick and `${` in the inline script was backslash-escaped (`\``, `\${`), a hard SyntaxError. Plus: treasurers got 403 on every treasury call because the 3 treasury handlers read `member.access?.canAccessTreasury`, but `requireActiveMember` never attaches `.access`. Plus transfer verify buttons read `dataset.verify_ok` instead of `dataset.verifyOk`. Plus "Modifier" duplicated instead of updating.

4. **`reports.html` corrupted script block** — see §2.

---

## 4. DONE ✅

### `db/schema.sql` (+262 lines, appended at end)
- `supco_local` added to the `portal_club_display_roles` role CHECK.
- `report_type` CHECK widened on **both** `portal_reports` and `portal_report_templates` to add: `plan_action`, `avancement_strategique`, `bilan_financier`, `plan_mediatique`, `bilan_mediatique`, `pre_delegation`, `post_delegation`, `partenariat`, `recommandation_parrains`, `identification_besoins`.
- `portal_report_templates` gained `owner_role` + `scope` columns (so a role workspace can list "the reports I'm statutorily responsible for").
- **5 new tables**, each mapped to a specific article (not generic note buckets):
  - `portal_club_recruitment` — VPI, RI I.7.7.2 (criteria + trial period + `alov_pending` state for RI I.7.7.3)
  - `portal_club_needs` — VPI, RI I.7.3.2.2 (routes to VPA or Responsable Régional)
  - `portal_club_partnerships` — VPE, RI I.8.4.2 (4 relation types; `al_pending` encodes RI I.8.4.2.6 "adopted in AL before official")
  - `portal_club_delegations` — VPE, RI I.8.4.1.2 (ANVI study, J-7 criteria date, J-4 delegate-selection date)
  - `portal_club_media_plans` — VPC, RI I.9.4.1.3-4 (plan *and* bilan, 3 phases, identity-conformity booleans)
- **10 report templates seeded**, taken one-for-one from the Annexe du système de mise à jour + RI I.8.4.2.4.4 / I.8.4.4.5 / I.9.4.1.3-4, each with `required_sections`, `validator_departments`, `owner_role`, deadline rule and `default_due_days` (negative = deadline *before* the event, matching the existing `pre_projet` convention).
- Pre-existing templates back-attributed to their owning post via `update ... where owner_role is null`.
- Style matches the file's existing idempotent conventions (`add column if not exists`, `drop constraint if exists` + re-add inside `do $$ … $$`), so it is **safe to re-run**.
- **Validated:** custom tokenizer confirms no unterminated string, `$$` markers balanced (16 = 8 blocks), paren balance 0.

### `api/_lib/roles.js` (+91/-14)
- `supco_local` added to `DISPLAY_ROLES`.
- New exported `BEL_ROLE_DEPARTMENTS` (post → department, RI I.1.1) and `BEL_ROLE_LABELS` (also now used by `getMemberRoleLabel`, replacing a duplicate inline map).
- Membership approver VPC → **VPI** in all 3 places.
- New access flags: `isVpi`, `isVpe`, `isVpc`, `isSupcoLocal`, `canAccessInternalRelations`, `canAccessExternalRelations`, `canAccessCommunication`, plus `department` and `roleLabel` passthrough.
  - Access flags are deliberately **wider** than identity flags: the président co-signs across departments (RI I.4.2.3-4) and a vacant post must not freeze the club (RI I.1.21, I.1.36).
- `canManageSupervision` / `canReviewSupervision` now also true for `supco_local`.

### `api/portal.js` (+267)
- New `BEL_RESOURCES` map + `coerceBelField()` + `belResource()` — **one** generic CRUD handler serving all five new resources (GET list / create / update / delete, club-scoped, author-or-admin rule).
- Uses `db.query(text, params)`. **Verified** against the official `@neondatabase/serverless@1.1.0` type declarations that `sql.query()` exists and (with `fullResults` unset in `db.js`) resolves to a **plain rows array** — v1.0 removed the ability to call the template function as a normal function, so `.query()` is the correct API here.
- Table/order-clause interpolation comes only from the frozen `BEL_RESOURCES` map, never from the request; every client value goes through a `$n` placeholder.
- Dispatcher: `if (Object.prototype.hasOwnProperty.call(BEL_RESOURCES, action)) return belResource(...)` — adds 5 actions without touching Vercel's 12-function cap (still one file).

### `public/portal/reports.html` (rewritten)
- Corrupted duplicate script region removed; page went 3 script blocks → 2, **both now parse**.
- Report *composition* moved out to the new editor page (per the request). `reports.html` is now purely stats + validation table + projects + tasks.
- "Reprendre" is now a link to `report-editor?id=…` and appears for `draft` **and** `invalidated`.
- Added missing department labels (`communication`, `ressources_humaines`, `relations_externes`) and made review chips use them.
- Null-guarded `fillAxis` / `syncSubAxes` so one missing node can't kill all event wiring (that was the original failure mode).

### `public/portal/report-editor.html` (NEW) — **this is the "place for editing any report"**
Fully **template-driven**, so every report you hand me plugs in with no new page:
- `?template=<slug>` → start a new report of that type; `?id=<reportId>` → reprise an existing one.
- Sections render dynamically from the template's `required_sections`; existing `payload` values are re-hydrated per section.
- Shows recipient, deadline rule, validator matrix and owning post as chips.
- Surfaces `invalid` review comments at the top when reprising a rejected report.
- Template picker with **Mes rapports / Tous les rapports locaux / Tous** (filters on the new `owner_role`).
- Échéance auto-suggested from `default_due_days`, anchored on the action date when given (negative = before).
- Save draft keeps you on the page and adopts the returned id so a second save updates instead of duplicating.
- **Inline script verified** to parse.

### `public/portal/bel-workspace.js` (NEW)
Shared list + create/edit + delete engine for the three new posts. The pages differ only in field list / columns / resource name, so this avoids three copies drifting apart. Server counterpart is `belResource()`. Handles camelCase→snake_case column fallback, sends `null` for empty fields, confirm-on-delete, edit mode, error surfacing. **Parses OK.**

### `public/portal/portal.css` (+24)
Shared `.bel-*` styles (tabs, panels, chips, `.row-actions`, `.inline-check`, `.duty-*`) used by all three new pages.

---

## 5. NOT DONE ❌ — pick up here

**Immediate next step: create the three pages.** `bel-workspace.js` + the CSS + the backend + the tables are all ready and verified; each page should be a thin declaration, roughly:

```html
<script src="portal-common.js"></script>
<script src="bel-workspace.js"></script>
<script>
AYCBelWorkspace.mount({
  resource: 'club_recruitment',
  accessFlag: 'canAccessInternalRelations',
  fields: [ /* key/label/type, keys must match BEL_RESOURCES field keys */ ],
  columns: [ /* {label, render(item, esc)} */ ],
  stats: [ /* {label, value(items)} */ ],
});
</script>
```

Required DOM ids the module expects: `notice`, `bel-workspace`, `bel-restricted`, `bel-kpis` (optional), `bel-rows`, `bel-form`, `bel-fields`, `bel-form-title`, `bel-submit`, `bel-cancel`, `btn-refresh` (optional).

1. ❌ **`vpi.html`** — resources `club_recruitment` + `club_needs`; flag `canAccessInternalRelations`. Duties RI I.7.2.1-7. Note the VPI is now also the membership approver → link to `admin-review`.
2. ❌ **`vpe.html`** — resources `club_partnerships` + `club_delegations`; flag `canAccessExternalRelations`. Duties RI I.8.2. Surface the J-7 / J-4 delegation deadlines (RI I.8.4.1.2.2/4).
3. ❌ **`vpc.html`** — resource `club_media`; flag `canAccessCommunication`. Duties RI I.9.2. Separate plan vs bilan (`document_kind`), RI I.9.4.1.3-4.
4. ❌ **`portal-common.js` nav** — add VPI / VPE / VPC under "Vie du club" gated on the three new flags; add `report-editor`; adopt the orphaned `responsibilities` page.
5. ❌ **`president.html`** — wire the 8 dead ids: `projets-list`, `rapport-pre`, `rapport-post`, `rapport-annuel`, `rapport-avancement`, `action-plan-content`, `kpi-projects`, `kpi-rapports`; replace the `alert('en cours de développement')` at ~line 285 with a link to `report-editor?template=plan_action_local`.
6. ❌ **`secretariat.html` polish** — `rules[].status` (~L396-402) is never read, so L412 always renders `badge-ok`: a missed deadline shows green. Also `loadRosterPresence`/`loadArchives` swallow errors to console only.
7. ❌ **Run the migration** — `node scripts/run-schema.js` against `DATABASE_URL`. **Nothing in §4's schema work has touched a real database yet.**
8. ❌ **End-to-end test** — no DB was available this session; all verification was static (parsers only).

---

## 6. How to verify what's been done

```powershell
# backend + shared JS parse
node --check api\portal.js
node --check api\_lib\roles.js
node --check public\portal\bel-workspace.js

# inline <script> blocks in a page (temp helper written this session)
node C:\Users\moham\AppData\Local\Temp\opencode\htmlcheck.js public\portal\reports.html
node C:\Users\moham\AppData\Local\Temp\opencode\htmlcheck.js public\portal\report-editor.html
node C:\Users\moham\AppData\Local\Temp\opencode\htmlcheck.js public\portal\tresorerie.html

# SQL quote/paren balance
node C:\Users\moham\AppData\Local\Temp\opencode\sqlcheck.js
```
All of the above passed when I stopped. The two temp helpers live in `%TEMP%\opencode\` and will not survive a cleanup — they're ~20 lines each and trivial to recreate (regex out `<script>…</script>`, feed each body to `new Function()`; and a tokenizer that tracks `'`, `''`, `--`, `$$`).

---

## 7. Caveats

- **No database was reachable this session.** Every claim above is from static verification. The schema migration is unapplied and the 5 new API actions have never executed against Postgres.
- **Uncommitted.** 5 modified + 2 new files. Nothing staged, no commit made (none was requested).
- `report_type` and the display-role CHECK are altered via `drop constraint if exists` + re-add. Re-running is safe, but if a row already violates a widened constraint the ALTER will fail loudly — expected, since widening only ever adds values.
- The membership VPC→VPI switch is the one change that can take away an ability someone is using today. See the warning in §3.1.
