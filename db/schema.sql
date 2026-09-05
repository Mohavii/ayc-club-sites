-- AYC YOUTHCLUBber member portal — database schema
--
-- This is a brand new, standalone Postgres database (Neon). It shares
-- NOTHING with the ayc-club-sites Discord bot / GitHub-as-database system:
-- no shared tables, no shared IDs, no foreign keys into that system, no
-- runtime calls to it. The only relationship is that `portal_schools` was
-- SEEDED ONCE from a copy of data/clubs/*.json's name/slug fields (see
-- seed-schools.sql) — after that one-time copy, this table is fully
-- independent and managed by national admins inside the portal.
--
-- Run this once against a fresh Neon database, e.g.:
--   psql "$DATABASE_URL" -f db/schema.sql
--   psql "$DATABASE_URL" -f db/seed-schools.sql

create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists btree_gist; -- exclusion constraints on uuid/integer

-- ---------------------------------------------------------------------
-- Schools / clubs a member can belong to (portal's own copy of the list)
-- ---------------------------------------------------------------------
create table if not exists portal_schools (
  id          serial primary key,
  slug        text unique not null,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- "Statut" column on the paper AG presence sheet ("Club membre" / "Nouveau
-- Club") — a slow-changing property of the club itself (not per-assembly),
-- so it lives on portal_schools rather than portal_assembly_club_attendance.
alter table portal_schools add column if not exists club_status text not null default 'club_membre';
do $$
begin
  alter table portal_schools drop constraint if exists portal_schools_club_status_check;
  alter table portal_schools add constraint portal_schools_club_status_check
    check (club_status in ('club_membre', 'nouveau_club'));
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------
create table if not exists portal_members (
  id                   uuid primary key default gen_random_uuid(),

  -- Google identity
  google_id            text unique not null,
  email                text not null,

  -- Chosen at onboarding
  username             text unique not null,
  display_name         text not null,
  profile_picture_url  text,
  school_id            integer references portal_schools(id),

  -- Membership lifecycle
  status               text not null default 'pending'
                         check (status in ('pending', 'active', 'rejected')),

  -- Official membership status (from final.pdf)
  membership_status    text not null default 'nouveau_adherent'
                         check (membership_status in (
                           'nouveau_adherent', 'adherent', 'responsable',
                           'senior', 'membre_national', 'ancien'
                         )),

  -- Portal-management admin flag. This is DELIBERATELY separate from
  -- any organizational title (see portal_national_roles below) — e.g.
  -- "Président National" is an org title, not portal-admin power, and
  -- someone can be a national admin without holding any org title at
  -- all. This flag only gates portal-management actions (e.g. who can
  -- assign roles) that have nowhere else sensible to live.
  is_national_admin    boolean not null default false,

  created_at           timestamptz not null default now(),
  decided_at           timestamptz,
  decided_by           uuid references portal_members(id),
  rejection_note       text
);

create index if not exists idx_portal_members_status on portal_members(status);
create index if not exists idx_portal_members_school on portal_members(school_id);
create index if not exists idx_portal_members_membership_status on portal_members(membership_status);

-- ---------------------------------------------------------------------
-- Member status history
-- ---------------------------------------------------------------------
create table if not exists portal_member_status_history (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  status      text not null,
  changed_by  uuid references portal_members(id),
  changed_at  timestamptz not null default now(),
  reason      text
);

create index if not exists idx_status_history_member on portal_member_status_history(member_id, changed_at desc);

-- ---------------------------------------------------------------------
-- Sessions — server-side, revocable. We deliberately do NOT use
-- stateless JWTs for the session itself: a national admin's decision
-- (approve/reject) or a status change must take effect on the member's
-- very next request, not whenever a token happens to expire. Only a
-- SHA-256 hash of the random session token is stored, never the raw
-- token (mirrors how you'd store a password-reset token) — a DB leak
-- alone can't be used to forge a session.
-- ---------------------------------------------------------------------
create table if not exists portal_sessions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);

create index if not exists idx_portal_sessions_member on portal_sessions(member_id);
create index if not exists idx_portal_sessions_expires on portal_sessions(expires_at);

-- ---------------------------------------------------------------------
-- OAuth handshake state (CSRF protection for the Google redirect)
-- ---------------------------------------------------------------------
create table if not exists portal_oauth_states (
  state       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- ---------------------------------------------------------------------
-- Signup tokens — bridge between "Google confirmed who this person is"
-- and "they finished the onboarding form". No member row is created
-- until onboarding is actually submitted; only a hash of the raw token
-- is stored, same rationale as sessions.
-- ---------------------------------------------------------------------
create table if not exists portal_signup_tokens (
  token_hash    text primary key,
  google_id     text not null,
  email         text not null,
  google_name   text,
  google_picture text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- =======================================================================
-- ROLE & PERMISSIONS SYSTEM
--
-- Three deliberately separate concepts, each its own table — do not
-- merge these, they answer different questions and have different
-- shapes (one is exclusive-per-club, one stacks freely, one has no
-- club at all):
--
--   1. portal_club_display_roles — "what position does this person
--      hold, and where" (Président, Secrétaire, ...). Shown on the
--      public profile as a badge. At most ONE currently-active row per
--      (member, club) — you can't be both Président and Secrétaire of
--      the same club at once. Has start/end dates, which is what
--      "Historique des postes occupés" reads from directly (past rows
--      = history, the one row with ended_at null = current).
--
--   2. portal_capability_grants — backend-only permissions (can
--      approve membership requests, can validate reports, can edit
--      PVs, ...). Never shown as a profile badge. Freely stackable: a
--      member can hold any number of these on the same club at the
--      same time, independent of what display role (if any) they
--      hold. Holding "Secrétaire" does NOT imply "pv-editor" — a
--      national admin grants pv-editor separately, even though in
--      practice they'll usually be granted to the same person.
--
--   3. portal_national_roles — organizational titles with NO club
--      scope at all (Président National, ...). Completely separate
--      from portal_members.is_national_admin: that flag is
--      portal-management power (can approve members, assign roles);
--      this table is an org title that may or may not come with any
--      portal capability. Someone can be Président National with zero
--      portal_capability_grants rows, and someone can be a national
--      admin while holding no title here at all.
-- =======================================================================

-- ---------------------------------------------------------------------
-- Role definitions — metadata about official roles
-- ---------------------------------------------------------------------
create table if not exists portal_role_definitions (
  slug        text primary key,
  name        text not null,
  description text,
  scope       text not null check (scope in ('club', 'national', 'regional')),
  required_training text -- e.g. 'COSTRA', 'RH', 'RELEX'
);

-- ---------------------------------------------------------------------
-- Club display roles — one currently-active role per member per club.
-- ---------------------------------------------------------------------
create table if not exists portal_club_display_roles (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  school_id   integer not null references portal_schools(id) on delete cascade,
  role        text not null check (role in (
                'president', 'tresorier', 'secretaire',
                'vpi', 'vpe', 'vpc', 'supco_regional'
              )),
  granted_by  uuid references portal_members(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz, -- null = currently holds this role

  -- Enforces "at most one CURRENT role per member per club" at the
  -- database level, not just in application code: a second insert for
  -- the same (member_id, school_id) while ended_at is still null will
  -- fail the unique constraint below. To change someone's role, end
  -- their current row (set ended_at = now()) and insert a new one —
  -- that's what naturally builds the history for free.
  constraint one_current_role_per_member_per_club
    exclude using gist (member_id with =, school_id with =)
    where (ended_at is null)
);

create index if not exists idx_club_roles_member on portal_club_display_roles(member_id);
create index if not exists idx_club_roles_school on portal_club_display_roles(school_id);
create index if not exists idx_club_roles_current on portal_club_display_roles(school_id, role) where ended_at is null;

-- The btree_gist extension is enabled near the top before exclusion
-- constraints are created.

-- ---------------------------------------------------------------------
-- Capability grants — stackable, backend-only, per club. Independent
-- of display roles: holding one implies nothing about the other.
-- ---------------------------------------------------------------------
create table if not exists portal_capability_grants (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  school_id   integer not null references portal_schools(id) on delete cascade,
  capability  text not null check (capability in (
                'membership_approver', 'report_validator', 'pv_editor',
                'meeting_organizer', 'project_manager', 'supervision_editor', 'cscy_reviewer'
              )),
  granted_by  uuid references portal_members(id),
  granted_at  timestamptz not null default now(),
  revoked_at   timestamptz -- null = currently active

  -- Deliberately NO uniqueness constraint on (member_id, school_id,
  -- capability) beyond what the app enforces on insert — a member can
  -- only usefully hold a given capability once at a time per club, but
  -- unlike display roles there's no hard exclusivity BETWEEN different
  -- capabilities, so a single exclude constraint doesn't apply here.
);

-- Keep the capability check in sync for databases created before the
-- project-manager permission was introduced.
do $$
begin
  alter table portal_capability_grants drop constraint if exists portal_capability_grants_capability_check;
  alter table portal_capability_grants add constraint portal_capability_grants_capability_check
    check (capability in ('membership_approver', 'report_validator', 'pv_editor', 'meeting_organizer', 'project_manager', 'supervision_editor', 'cscy_reviewer'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_capability_grants_member on portal_capability_grants(member_id);
create index if not exists idx_capability_grants_lookup
  on portal_capability_grants(school_id, capability) where revoked_at is null;

-- National capabilities have no club scope. They are intentionally separate
-- from portal_capability_grants so a permission such as national_projects
-- cannot accidentally become tied to one local club.
create table if not exists portal_national_capability_grants (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  capability  text not null check (capability in ('national_projects')),
  granted_by  uuid references portal_members(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index if not exists idx_national_capability_grants_member
  on portal_national_capability_grants(member_id, capability) where revoked_at is null;


-- ---------------------------------------------------------------------
-- National roles — organizational titles with no club scope. Entirely
-- separate from portal_members.is_national_admin (see comment above
-- that column). Same "one current row, history via ended_at" pattern
-- as club display roles, just without a school_id.
-- ---------------------------------------------------------------------
create table if not exists portal_national_roles (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  role        text not null check (role in (
                'president_national'
                -- add further national-scope titles here as they're
                -- decided — kept deliberately short until named.
              )),
  granted_by  uuid references portal_members(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,

  constraint one_current_national_role_per_member
    exclude using gist (member_id with =, role with =)
    where (ended_at is null)
);

create index if not exists idx_national_roles_member on portal_national_roles(member_id);

-- ---------------------------------------------------------------------
-- Équipe Plénière Locale (EPL) — the local-assembly counterpart of the
-- EPN, but scoped to a club (school_id) instead of the whole org. Seated
-- the same way as club display roles (one active row per member+club,
-- history via ended_at), EXCEPT a member can never be seated as EPL for
-- their OWN club (school_id) — the presiding plenary team for a club's
-- local assembly (ALOE/ALOFM/ALE) has to come from outside that club.
-- That rule is enforced in application code (setEplMember below) since
-- it depends on the target member's own school_id at grant time, not
-- something a DB check constraint on this table alone can express.
-- ---------------------------------------------------------------------
create table if not exists portal_epl_roles (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references portal_members(id) on delete cascade,
  school_id   integer not null references portal_schools(id) on delete cascade,
  role        text not null check (role in (
                'epl_president', 'epl_vice_president', 'epl_secretaire',
                'epl_cscy', 'epl_comite_financier'
              )),
  granted_by  uuid references portal_members(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,

  constraint one_current_epl_role_per_member_per_club
    exclude using gist (member_id with =, school_id with =, role with =)
    where (ended_at is null)
);

create index if not exists idx_epl_roles_member on portal_epl_roles(member_id);
create index if not exists idx_epl_roles_school on portal_epl_roles(school_id, role) where ended_at is null;


-- =======================================================================
-- MEMBER PORTAL WORKSPACE FEATURES
-- =======================================================================

alter table portal_members add column if not exists phone text;
alter table portal_members add column if not exists education_level text;
alter table portal_members add column if not exists cover_photo_url text;
alter table portal_members add column if not exists formateur_track boolean not null default false;
alter table portal_members add column if not exists bio text;

create table if not exists portal_projects (
  id uuid primary key default gen_random_uuid(),
  school_id integer references portal_schools(id) on delete cascade,
  created_by uuid not null references portal_members(id),
  title text not null,
  description text,
  project_type text not null default 'projet',
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','in_progress','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_projects_school on portal_projects(school_id, starts_at);

alter table portal_projects add column if not exists scope text not null default 'local';
alter table portal_projects alter column school_id drop not null;
alter table portal_projects add column if not exists president_id uuid references portal_members(id) on delete set null;
update portal_projects set president_id = created_by where president_id is null;
alter table portal_projects drop constraint if exists portal_projects_scope_check;
alter table portal_projects add constraint portal_projects_scope_check check (scope in ('local','national'));

create index if not exists idx_portal_projects_scope on portal_projects(scope, starts_at);
create index if not exists idx_portal_projects_president on portal_projects(president_id);

-- Local projects can be run jointly by a second club. When set, the
-- collaborating club's current president gets the same authority over
-- the project as the project's own (fixed-at-creation) president, and
-- the collaborating club's members can see the project.
alter table portal_projects add column if not exists collaborating_school_id integer references portal_schools(id) on delete set null;
create index if not exists idx_portal_projects_collab_school on portal_projects(collaborating_school_id);

create table if not exists portal_project_teams (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references portal_projects(id) on delete cascade,
  name text not null,
  supervisor_id uuid references portal_members(id) on delete set null,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_project_teams_project on portal_project_teams(project_id);
create index if not exists idx_portal_project_teams_supervisor on portal_project_teams(supervisor_id);

create table if not exists portal_project_team_members (
  team_id uuid not null references portal_project_teams(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  assigned_by uuid references portal_members(id),
  assigned_at timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index if not exists idx_project_team_members_member on portal_project_team_members(member_id);

create table if not exists portal_meetings (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  created_by uuid not null references portal_members(id),
  title text not null,
  meeting_type text not null check (meeting_type in ('reunion_locale','reunion_nationale','reunion','assemblee_locale','assemblee_generale')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  format text not null default 'presentiel' check (format in ('presentiel','en_ligne','hybride')),
  location text,
  maps_url text,
  comments text,
  agenda jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_meetings_school_date on portal_meetings(school_id, starts_at desc);

create table if not exists portal_meeting_attendees (
  meeting_id uuid not null references portal_meetings(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  rsvp text not null default 'pending' check (rsvp in ('pending','present','absent')),
  voting_rights boolean not null default false,
  primary key (meeting_id, member_id)
);

create table if not exists portal_minutes (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid unique not null references portal_meetings(id) on delete cascade,
  mode text not null default 'standard' check (mode in ('standard','assemblee_generale')),
  mandate text,
  organizer text,
  drafted_at timestamptz,
  sent_at timestamptz,
  redactors jsonb not null default '[]'::jsonb,
  attendance jsonb not null default '[]'::jsonb,
  agenda_blocks jsonb not null default '[]'::jsonb,
  motions jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','sent','validated')),
  created_by uuid not null references portal_members(id),
  updated_at timestamptz not null default now()
);

create table if not exists portal_reports (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  submitted_by uuid not null references portal_members(id),
  report_type text not null check (report_type in ('pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation')),
  title text not null,
  event_date date,
  description text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','submitted','validated','invalidated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_reports_scope on portal_reports(school_id, created_at desc);

create table if not exists portal_report_reviews (
  report_id uuid not null references portal_reports(id) on delete cascade,
  department text not null,
  status text not null default 'pending' check (status in ('pending','valid','invalid')),
  comment text,
  reviewer_id uuid references portal_members(id),
  reviewed_at timestamptz,
  primary key (report_id, department)
);

-- ---------------------------------------------------------------------
-- Trainer portfolio, awards, and member dossier documents (PHASE 4)
-- ---------------------------------------------------------------------
create table if not exists portal_member_documents (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  uploaded_by uuid not null references portal_members(id),
  document_type text not null check (document_type in ('candidature','training_evidence','trainer_certificate','award_evidence','other')),
  title text not null,
  description text,
  storage_key text not null unique,
  storage_url text,
  original_filename text,
  mime_type text not null,
  size_bytes bigint not null default 0,
  visibility text not null default 'owner_admins' check (visibility in ('active_members','owner_admins')),
  status text not null default 'pending' check (status in ('pending','validated','rejected','archived')),
  validated_by uuid references portal_members(id),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_documents_member on portal_member_documents(member_id, document_type, created_at desc);
create index if not exists idx_portal_documents_visibility on portal_member_documents(visibility, status, created_at desc);

create table if not exists portal_trainer_profiles (
  member_id uuid primary key references portal_members(id) on delete cascade,
  certification_status text not null default 'pending' check (certification_status in ('pending','verified','suspended')),
  homologated_at timestamptz,
  expertise_domains jsonb not null default '[]'::jsonb,
  oath_text text,
  other_activity text,
  verified_by uuid references portal_members(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists portal_member_awards (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  title text not null,
  issuer text,
  awarded_on date,
  value_tag text,
  description text,
  evidence_document_id uuid references portal_member_documents(id) on delete set null,
  visibility text not null default 'active_members' check (visibility in ('active_members','owner_admins')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_awards_member on portal_member_awards(member_id, awarded_on desc nulls last, created_at desc);

create table if not exists portal_training_entries (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  category text not null check (category in ('niveau_youthclubeur','coordination_strategique','relations_externes','ressources_humaines','tresorerie','secretariat','communication','received','delivered','facilitation','other')),
  title text not null,
  host text,
  held_on date,
  location text,
  booklet_url text,
  hours numeric(8,2),
  validation_status text not null default 'pending' check (validation_status in ('pending','validated','rejected')),
  validated_by uuid references portal_members(id),
  validated_at timestamptz,
  notes text,
  evidence_document_id uuid references portal_member_documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_training_member on portal_training_entries(member_id, held_on desc);

alter table portal_training_entries add column if not exists evidence_document_id uuid references portal_member_documents(id) on delete set null;
alter table portal_training_entries add column if not exists validation_status text not null default 'pending';
alter table portal_training_entries add column if not exists validated_by uuid references portal_members(id);
alter table portal_training_entries add column if not exists validated_at timestamptz;
alter table portal_training_entries add column if not exists updated_at timestamptz not null default now();

-- =======================================================================
-- FORMATION SESSIONS (VPI schedules -> formateurs accept -> members sign up)
-- =======================================================================
-- A club's VPI schedules a formation session for a given category (only
-- 'niveau_youthclubeur' is offered today; the category column + check
-- constraint keep this a real dropdown that's simply one-item for now, so
-- adding more official formations later is a constraint change, not a
-- redesign). The request is visible to every verified formateur; whichever
-- one accepts first claims it (status flips to 'open') and it becomes
-- visible to members of the requesting club for sign-up. A formateur can
-- also decline without blocking others from accepting afterwards, so
-- declines are recorded on a separate table rather than as terminal status.
create table if not exists portal_formation_sessions (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  category text not null default 'niveau_youthclubeur' check (category in ('niveau_youthclubeur')),
  requested_by uuid not null references portal_members(id),
  proposed_date date not null,
  location text,
  notes text,
  capacity integer not null default 20 check (capacity > 0),
  status text not null default 'requested' check (status in ('requested', 'open', 'cancelled', 'completed')),
  accepted_by uuid references portal_members(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_formation_sessions_school on portal_formation_sessions(school_id, status);
create index if not exists idx_portal_formation_sessions_status on portal_formation_sessions(status, category);

-- Formateurs who've explicitly declined a still-'requested' session, so the
-- UI can hide it from someone who already passed on it while leaving it
-- open to every other formateur.
create table if not exists portal_formation_session_declines (
  session_id uuid not null references portal_formation_sessions(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  declined_at timestamptz not null default now(),
  primary key (session_id, member_id)
);

-- Member sign-ups once a session is 'open' — capped at session.capacity,
-- enforced in the API (count + insert) since Postgres has no native
-- "max N rows per group" constraint without a trigger.
create table if not exists portal_formation_signups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references portal_formation_sessions(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  signed_up_at timestamptz not null default now(),
  attendance_status text not null default 'registered' check (attendance_status in ('registered', 'attended', 'no_show')),
  unique (session_id, member_id)
);
create index if not exists idx_portal_formation_signups_session on portal_formation_signups(session_id);

-- The accepting formateur's own phase breakdown for that session — every
-- formateur presents the same official formation differently, so this is
-- freeform per-session content rather than a shared curriculum table.
create table if not exists portal_formation_phases (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references portal_formation_sessions(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  body text,
  duration_text text,
  created_by uuid references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, position)
);
create index if not exists idx_portal_formation_phases_session on portal_formation_phases(session_id, position);

create table if not exists portal_tasks (
  id uuid primary key default gen_random_uuid(),
  school_id integer references portal_schools(id) on delete cascade,
  assigned_to uuid not null references portal_members(id) on delete cascade,
  project_id uuid references portal_projects(id) on delete set null,
  title text not null,
  description text,
  priority text not null default 'normale' check (priority in ('basse','normale','haute','urgente')),
  assigned_at timestamptz not null default now(),
  deadline date,
  status text not null default 'a_faire' check (status in ('a_faire','soumis','executee','hors_delai')),
  comments text,
  submission_note text,
  created_by uuid not null references portal_members(id),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_tasks_assignee on portal_tasks(assigned_to, deadline);
alter table portal_tasks add column if not exists submission_note text;

create table if not exists portal_responsibilities (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  school_id integer references portal_schools(id) on delete cascade,
  title text not null,
  description text,
  project_url text,
  database_url text,
  held_on date,
  status text not null default 'proposed' check (status in ('proposed', 'validated', 'rejected')),
  validated_by uuid references portal_members(id),
  validated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_responsibilities_member on portal_responsibilities(member_id, held_on desc);

-- =======================================================================
-- STRUCTURED MEETINGS, ASSEMBLIES, AND PV EDITOR (PHASE 2)
-- Existing JSONB columns remain for backward compatibility; these relations
-- provide auditable rows for agenda, attendance, and motions.
-- =======================================================================

alter table portal_meetings add column if not exists status text not null default 'planned';
alter table portal_meetings add column if not exists chair_id uuid references portal_members(id) on delete set null;
alter table portal_meetings add column if not exists secretary_id uuid references portal_members(id) on delete set null;
alter table portal_meetings add column if not exists cancelled_at timestamptz;

alter table portal_minutes add column if not exists closing_at timestamptz;
alter table portal_minutes add column if not exists duration_minutes integer;
alter table portal_minutes add column if not exists validated_by uuid references portal_members(id) on delete set null;
alter table portal_minutes add column if not exists validated_at timestamptz;
alter table portal_minutes add column if not exists club_presence jsonb not null default '[]'::jsonb;

alter table portal_meeting_attendees add column if not exists attendance_status text not null default 'invited';
alter table portal_meeting_attendees add column if not exists member_role text;

create table if not exists portal_meeting_agenda_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references portal_meetings(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  duration_minutes integer,
  notes text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  unique (meeting_id, position)
);
create index if not exists idx_portal_agenda_items_meeting on portal_meeting_agenda_items(meeting_id, position);

create table if not exists portal_minutes_attendance (
  id uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references portal_minutes(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  attendance_status text not null default 'present',
  voting_rights boolean not null default false,
  member_role text,
  note text,
  unique (minutes_id, member_id)
);
create index if not exists idx_portal_minutes_attendance_minutes on portal_minutes_attendance(minutes_id);

create table if not exists portal_minutes_agenda_blocks (
  id uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references portal_minutes(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  discussion text,
  decision text,
  duration_minutes integer,
  unique (minutes_id, position)
);
create index if not exists idx_portal_minutes_agenda_blocks_minutes on portal_minutes_agenda_blocks(minutes_id, position);

create table if not exists portal_minutes_motions (
  id uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references portal_minutes(id) on delete cascade,
  position integer not null default 0,
  motion_type text not null default 'decision',
  title text not null,
  proposer_id uuid references portal_members(id) on delete set null,
  seconder_id uuid references portal_members(id) on delete set null,
  amendment text,
  direct_negative text,
  majority_type text,
  votes_for integer not null default 0,
  votes_against integer not null default 0,
  abstentions integer not null default 0,
  result text,
  consequence text,
  unique (minutes_id, position)
);
create index if not exists idx_portal_minutes_motions_minutes on portal_minutes_motions(minutes_id, position);

-- =======================================================================
-- REPORT TEMPLATES, DEADLINES, AND STRATEGIC AXES (PHASE 3)
-- =======================================================================

create table if not exists portal_strategic_axes (
  slug text primary key,
  name text not null,
  description text,
  sort_order integer not null default 0
);

create table if not exists portal_strategic_sub_axes (
  slug text primary key,
  axis_slug text not null references portal_strategic_axes(slug) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0
);

insert into portal_strategic_axes (slug, name, description, sort_order) values
  ('scolarite', 'Scolarité', 'Réussite scolaire, orientation et accompagnement éducatif.', 1),
  ('education_formelle', 'Éducation formelle', 'Apprentissages, transmission et développement des compétences.', 2),
  ('sante_4d', 'Santé en 4D', 'Santé physique, mentale, sociale et environnementale.', 3),
  ('citoyennete', 'Citoyenneté', 'Engagement, droits, devoirs et participation à la vie collective.', 4),
  ('vie_active', 'Vie active', 'Insertion, autonomie, projets et préparation à la vie professionnelle.', 5)
on conflict (slug) do nothing;

create table if not exists portal_report_templates (
  slug text primary key,
  name text not null,
  report_type text not null check (report_type in ('pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation')),
  description text,
  recipient text,
  deadline_rule text,
  default_due_days integer,
  required_sections jsonb not null default '[]'::jsonb,
  validator_departments jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into portal_report_templates
  (slug, name, report_type, description, recipient, deadline_rule, default_due_days, required_sections, validator_departments)
values
  ('pre_projet', 'Rapport pré-projet', 'pre_projet', 'À préparer avant le premier engagement externe.', 'Bureau exécutif local', '7 jours avant le premier engagement externe', -7, '["contexte", "objectifs", "public", "budget", "risques", "indicateurs"]'::jsonb, '["coordination_strategique", "tresorerie"]'::jsonb),
  ('post_projet', 'Rapport post-projet', 'post_projet', 'Bilan à transmettre après la fin du projet.', 'Bureau exécutif local', '10 jours après la fin du projet', 10, '["realisation", "participants", "resultats", "budget", "evaluation", "pieces_jointes"]'::jsonb, '["coordination_strategique", "tresorerie"]'::jsonb),
  ('proces_verbal', 'Procès-verbal', 'proces_verbal', 'Procès-verbal structuré de réunion ou d’assemblée.', 'Instance concernée', 'Après la clôture de la séance', 0, '["mandat", "ordre_du_jour", "presence", "decisions", "cloture"]'::jsonb, '["secretariat", "supervision"]'::jsonb),
  ('collaboration', 'Rapport collaboration / partenariat', 'collaboration', 'Suivi d’un partenariat ou d’une collaboration.', 'Bureau exécutif local', 'Selon la convention', 0, '["partenaire", "objectifs", "engagements", "resultats", "suite"]'::jsonb, '["relations_exterieures", "coordination_strategique"]'::jsonb),
  ('mise_a_jour', 'Rapport de mise à jour', 'mise_a_jour', 'Mise à jour périodique de la vie du club.', 'Bureau exécutif national', 'Selon le calendrier annuel', 0, '["instruction", "prise_de_fonction", "passation", "encadrement", "attente_des_objectifs", "chronologie_des_methodologies", "implementation", "evaluation", "auto_evaluation", "recommandations"]'::jsonb, '["coordination_strategique", "secretariat"]'::jsonb),
  ('plan_action_annuel', 'Rapport du Plan d’action annuel du Club', 'mise_a_jour', 'Planification annuelle détaillée des tâches par département.', 'Bureau exécutif national', 'J+7 après élection du BEL', 7, '["contextualisation", "plan_action_tableau"]'::jsonb, '["coordination_strategique"]'::jsonb),
  ('supervision', 'Rapport de supervision', 'supervision', 'Dossier adressé à une instance de supervision.', 'Conseil de supervision compétent', 'À la demande de l’instance', 0, '["faits", "pieces", "mesures", "suivi"]'::jsonb, '["supervision"]'::jsonb),
  ('investigation', 'Rapport d’investigation', 'investigation', 'Dossier d’examen et de décision disciplinaire.', 'Conseil de supervision compétent', 'À la demande de l’instance', 0, '["saisine", "faits", "auditions", "constats", "decision"]'::jsonb, '["supervision", "cscy"]'::jsonb)
on conflict (slug) do nothing;

alter table portal_projects add column if not exists axis_slug text references portal_strategic_axes(slug) on delete set null;
alter table portal_projects add column if not exists sub_axis_slug text references portal_strategic_sub_axes(slug) on delete set null;
alter table portal_projects add column if not exists objectives text;
alter table portal_projects add column if not exists expected_results text;
alter table portal_projects add column if not exists evaluation_method text;
alter table portal_projects add column if not exists stakeholders jsonb not null default '[]'::jsonb;
alter table portal_projects add column if not exists indicators jsonb not null default '[]'::jsonb;

alter table portal_reports add column if not exists project_id uuid references portal_projects(id) on delete set null;
alter table portal_reports add column if not exists template_slug text references portal_report_templates(slug) on delete set null;
alter table portal_reports add column if not exists recipient text;
alter table portal_reports add column if not exists axis_slug text references portal_strategic_axes(slug) on delete set null;
alter table portal_reports add column if not exists sub_axis_slug text references portal_strategic_sub_axes(slug) on delete set null;
alter table portal_reports add column if not exists due_at timestamptz;
alter table portal_reports add column if not exists submitted_at timestamptz;

create index if not exists idx_portal_projects_axis on portal_projects(axis_slug, sub_axis_slug);
create index if not exists idx_portal_reports_deadline on portal_reports(school_id, due_at);
create index if not exists idx_portal_reports_template on portal_reports(template_slug);

create table if not exists portal_report_deadlines (
  id uuid primary key default gen_random_uuid(),
  template_slug text not null references portal_report_templates(slug) on delete cascade,
  school_id integer not null references portal_schools(id) on delete cascade,
  project_id uuid references portal_projects(id) on delete set null,
  report_id uuid references portal_reports(id) on delete set null,
  due_at timestamptz not null,
  status text not null default 'upcoming' check (status in ('upcoming','late','completed','escalated','cancelled')),
  reminder_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_report_deadlines_scope on portal_report_deadlines(school_id, due_at);


-- =======================================================================
-- SUPERVISION, ASSEMBLIES, ELECTIONS, AND GOVERNANCE AUDIT (PHASE 5)
-- These tables are deliberately additive. Existing meetings, minutes, reports,
-- roles, and member data remain compatible while gaining structured governance
-- records and immutable snapshots for portal traceability.
-- =======================================================================

create table if not exists portal_role_catalog (
  slug text primary key,
  display_name text not null,
  scope text not null check (scope in ('club','regional','national','advisory','supervision','constitutional')),
  description text,
  voting_scope text,
  active boolean not null default true
);

insert into portal_role_catalog (slug, display_name, scope, description, voting_scope) values
  ('bel', 'Bureau Exécutif Local', 'club', 'Instance exécutive locale.', 'club'),
  ('ben', 'Bureau Exécutif National', 'national', 'Instance exécutive nationale.', 'ag'),
  ('supco_local', 'Conseil de Supervision Local', 'supervision', 'Instance indépendante de supervision locale.', 'none'),
  ('supco_national', 'Conseil de Supervision National', 'supervision', 'Instance indépendante de supervision nationale.', 'none'),
  ('cns', 'Conseil National des Seniors', 'advisory', 'Instance consultative nationale.', 'ag_single'),
  ('cls', 'Conseil Local des Seniors', 'advisory', 'Instance consultative locale.', 'none'),
  ('cscy', 'Conseil de Sauvegarde de la Constitution Youth', 'constitutional', 'Conseil chargé des droits de vote et de la conformité des motions.', 'none'),
  ('gdt', 'Groupe de Travail', 'advisory', 'Groupe de travail mandaté par une instance.', 'none'),
  ('coordinateur_regional', 'Coordinateur Stratégique Régional', 'regional', 'Coordination stratégique régionale.', 'regional'),
  ('president', 'Président', 'club', 'Présidence du bureau exécutif local ou national.', 'club'),
  ('secretaire', 'Secrétaire', 'club', 'Secrétariat du bureau exécutif local ou national.', 'club'),
  ('tresorier', 'Trésorier', 'club', 'Trésorerie du bureau exécutif local ou national.', 'club'),
  ('vpi', 'VPI', 'club', 'Vice-présidence interne locale.', 'club'),
  ('vpe', 'VPE', 'club', 'Vice-présidence externe locale.', 'club'),
  ('vpc', 'VPC', 'club', 'Vice-présidence communication locale.', 'club')
on conflict (slug) do nothing;

create table if not exists portal_role_training_requirements (
  role_slug text not null references portal_role_catalog(slug) on delete cascade,
  department text not null,
  required boolean not null default true,
  description text,
  primary key (role_slug, department)
);

insert into portal_role_training_requirements (role_slug, department, description) values
  ('president', 'coordination_strategique', 'Formation COSTRA requise.'),
  ('secretaire', 'secretariat', 'Formation Secrétariat requise.'),
  ('tresorier', 'tresorerie', 'Formation Trésorerie requise.'),
  ('vpi', 'ressources_humaines', 'Formation RH requise.'),
  ('vpe', 'relations_exterieures', 'Formation RELEX requise.'),
  ('vpc', 'communication', 'Formation COM requise.'),
  ('cscy', 'supervision', 'Formation de conformité constitutionnelle requise.')
on conflict do nothing;

create table if not exists portal_assemblies (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid unique not null references portal_meetings(id) on delete cascade,
  school_id integer references portal_schools(id) on delete cascade,
  assembly_type text not null check (assembly_type in ('alofm','ale','aloe','agomm','agofm','age')),
  scope text not null default 'local' check (scope in ('local','national')),
  status text not null default 'planned' check (status in ('planned','open','closed','cancelled')),
  member_snapshot_count integer not null default 0,
  quorum_required integer not null default 0,
  eligible_voter_count integer not null default 0,
  quorum_met boolean,
  voter_snapshot jsonb not null default '[]'::jsonb,
  project_url text,
  database_url text,
  outcome_summary text,
  created_by uuid not null references portal_members(id),
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_assemblies_school on portal_assemblies(school_id, status, created_at desc);

-- Migrate assembly types from the old set (alofm/adhesion/validation/aloe/
-- dissolution/ag_ordinaire/ag_extraordinaire) to the new set (alofm/
-- ale/aloe/agomm/agofm/age) on databases created before this change.
-- ALOMM briefly existed as a type in between and doesn't correspond to a
-- real AYC assembly, so any legacy row stamped 'alomm' is folded into
-- 'alofm' the same way the other retired types are folded above.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'portal_assemblies' and column_name = 'assembly_type'
  ) then
    alter table portal_assemblies drop constraint if exists portal_assemblies_assembly_type_check;
    update portal_assemblies set assembly_type = 'agomm' where assembly_type in ('ag_ordinaire', 'adhesion', 'validation');
    update portal_assemblies set assembly_type = 'age' where assembly_type = 'ag_extraordinaire';
    update portal_assemblies set assembly_type = 'ale' where assembly_type = 'dissolution';
    update portal_assemblies set assembly_type = 'alofm' where assembly_type = 'alomm';
    alter table portal_assemblies add constraint portal_assemblies_assembly_type_check check (assembly_type in ('alofm','ale','aloe','agomm','agofm','age'));
  end if;
end $$;

-- Extra Contextualisation fields from the paper PV's "I. Contextualisation"
-- block: adoption state and the named rédacteurs (with their club), shown
-- above the type/organisateur/lieu fields already covered by the assembly
-- + meeting rows.
alter table portal_assemblies add column if not exists adoption_state text not null default 'draft' check (adoption_state in ('draft', 'submitted_for_adoption', 'adopted'));
alter table portal_assemblies add column if not exists editors jsonb not null default '[]'::jsonb; -- [{ name, club }]

create table if not exists portal_assembly_roles (
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  role text not null,
  note text,
  primary key (assembly_id, member_id, role)
);

create table if not exists portal_assembly_attendance (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  attendance_status text not null default 'invited' check (attendance_status in ('invited','present','absent','excused','late')),
  voting_rights boolean not null default false,
  eligibility_basis text,
  assigned_by uuid references portal_members(id),
  note text,
  unique (assembly_id, member_id)
);
create index if not exists idx_portal_assembly_attendance_assembly on portal_assembly_attendance(assembly_id, attendance_status);

create table if not exists portal_assembly_motions (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  position integer not null default 0,
  motion_type text not null default 'decision',
  title text not null,
  majority_type text not null default 'simple' check (majority_type in ('simple','absolute','relative','two_thirds')),
  required_motion boolean not null default false,
  votes_for integer not null default 0,
  votes_against integer not null default 0,
  abstentions integer not null default 0,
  result text,
  consequence text,
  created_at timestamptz not null default now(),
  unique (assembly_id, position)
);
-- Free-text fields matching the paper PV format used in the field (proposer/seconder are often
-- written by name rather than tied to a member account, incl. national bureau or observers).
alter table portal_assembly_motions add column if not exists proposer_name text;
alter table portal_assembly_motions add column if not exists seconder_name text;
alter table portal_assembly_motions add column if not exists amendment text;
alter table portal_assembly_motions add column if not exists direct_negative text;
alter table portal_assembly_motions add column if not exists discussion text;
alter table portal_assembly_motions add column if not exists starts_at_text text;
alter table portal_assembly_motions add column if not exists closes_at_text text;
alter table portal_assembly_motions add column if not exists duration_text text;
alter table portal_assembly_motions add column if not exists vote_mode text not null default 'count' check (vote_mode in ('count','manual'));
alter table portal_assembly_motions add column if not exists manual_result text check (manual_result in ('adopted','rejected','tie',null));

create table if not exists portal_investigations (
  id uuid primary key default gen_random_uuid(),
  school_id integer references portal_schools(id) on delete set null,
  subject_member_id uuid references portal_members(id) on delete set null,
  opened_by uuid not null references portal_members(id),
  level text not null default 'local' check (level in ('local','national')),
  category text not null check (category in ('communication','personal_conflict','regulation','law','other')),
  title text not null,
  summary text,
  status text not null default 'open' check (status in ('open','under_review','decision','closed','dismissed')),
  confidentiality text not null default 'supervision' check (confidentiality in ('supervision','national_only')),
  decision text,
  restriction_summary text,
  decision_assembly_id uuid references portal_assemblies(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_investigations_scope on portal_investigations(school_id, level, status, opened_at desc);

create table if not exists portal_investigation_events (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references portal_investigations(id) on delete cascade,
  actor_id uuid not null references portal_members(id),
  event_type text not null check (event_type in ('note','evidence','hearing','decision','restriction','status_change')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_investigation_events_case on portal_investigation_events(investigation_id, created_at);

create table if not exists portal_elections (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  office text not null,
  scope text not null check (scope in ('local','national','regional')),
  status text not null default 'planned' check (status in ('planned','open','completed','no_election')),
  majority_type text not null default 'absolute' check (majority_type in ('simple','absolute','relative','two_thirds')),
  winner_member_id uuid references portal_members(id) on delete set null,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_elections_assembly on portal_elections(assembly_id, status);

create table if not exists portal_election_candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references portal_elections(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  eligibility_status text not null default 'pending' check (eligibility_status in ('pending','eligible','ineligible')),
  statement text,
  unique (election_id, member_id)
);

create table if not exists portal_election_rounds (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references portal_elections(id) on delete cascade,
  round_number integer not null,
  discussion_minutes integer,
  tie_note text,
  status text not null default 'planned' check (status in ('planned','open','closed')),
  created_at timestamptz not null default now(),
  unique (election_id, round_number)
);

create table if not exists portal_election_tallies (
  round_id uuid not null references portal_election_rounds(id) on delete cascade,
  candidate_id uuid not null references portal_election_candidates(id) on delete cascade,
  votes_for integer not null default 0,
  abstentions integer not null default 0,
  primary key (round_id, candidate_id)
);

create table if not exists portal_mandates (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  school_id integer references portal_schools(id) on delete cascade,
  scope text not null check (scope in ('local','national','regional')),
  office text not null,
  assembly_id uuid references portal_assemblies(id) on delete set null,
  starts_on date,
  ends_on date,
  status text not null default 'proposed' check (status in ('proposed','active','completed','rejected')),
  handover_notes text,
  approved_by uuid references portal_members(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_mandates_member on portal_mandates(member_id, status, starts_on desc);

create table if not exists portal_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references portal_members(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_audit_events_entity on portal_audit_events(entity_type, entity_id, created_at desc);
create index if not exists idx_portal_audit_events_actor on portal_audit_events(actor_id, created_at desc);

-- =======================================================================
-- ÉQUIPE PLÉNIÈRE NATIONALE (EPN) + NATIONAL AG CLUB ATTENDANCE (PHASE 6)
-- =======================================================================
-- EPN is a standing body (like BEN) rather than a single seat, so it is
-- modeled as a stackable national role — many members can hold
-- 'epn_member' at once, same "one current row, history via ended_at"
-- pattern as the other national roles. A dedicated 'secretaire_national'
-- role is added alongside it so the person(s) who write the national AG
-- PV can be recognized without a club_id and without needing the
-- pv_editor capability (see roles.js: national AGs accept either
-- pv_editor OR the secretaire_national title).
do $$
begin
  alter table portal_national_roles drop constraint if exists portal_national_roles_role_check;
  alter table portal_national_roles add constraint portal_national_roles_role_check
    check (role in ('president_national', 'epn_member', 'secretaire_national'));
exception when duplicate_object then null;
end $$;

-- One row per (assembly, school) tracking whether that CLUB — not an
-- individual member — showed up to a national AG and whether its seat
-- is voting, matching the paper attendance sheet format ("Lycée Pilote
-- X" rows with Présent/Absent + Votant/Non votant dropdowns). Distinct
-- from portal_assembly_attendance, which tracks individual members and
-- is still used for the EPN/BEN roster on the same assembly.
create table if not exists portal_assembly_club_attendance (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  school_id integer not null references portal_schools(id) on delete cascade,
  attendance_status text not null default 'absent' check (attendance_status in ('present','absent')),
  voting_status text not null default 'non_votant' check (voting_status in ('votant','non_votant')),
  assigned_by uuid references portal_members(id),
  updated_at timestamptz not null default now(),
  unique (assembly_id, school_id)
);
create index if not exists idx_portal_assembly_club_attendance_assembly on portal_assembly_club_attendance(assembly_id);

-- Paper sheet has a "Représentant" column next to each club row (who showed
-- up for that club) — free text since it's filled in on the day and the
-- person may not have a portal account.
alter table portal_assembly_club_attendance add column if not exists representative_name text;

-- =======================================================================
-- BEN / SUPCO NATIONAL POSTS (PHASE 7 — full PV parity with the paper AG)
-- =======================================================================
-- Named national offices beyond président_national/EPN/secrétaire, matching
-- "La liste de présence du Bureau Exécutif National et les membres du
-- Conseil de Supervision" on the paper PV. Same "one current row, history
-- via ended_at" pattern as the rest of portal_national_roles — a post can
-- be vacant (no current row) and the UI renders that as "Vacant".
do $$
begin
  alter table portal_national_roles drop constraint if exists portal_national_roles_role_check;
  alter table portal_national_roles add constraint portal_national_roles_role_check
    check (role in (
      'president_national', 'epn_member', 'secretaire_national',
      'secretaire_general_national', 'tresorier_national', 'vpa', 'vpr', 'vpcom', 'supco_national'
    ));
exception when duplicate_object then null;
end $$;

-- =======================================================================
-- PLÉNIÈRES (PHASE 7)
-- =======================================================================
-- A national AG runs across several "plénières" (sessions), each with its
-- own start/end time and its own équipe plénière (président/vice-président/
-- secrétaires/CSCY/CF) — see "La première plénière", "Plénière 2", etc. on
-- the paper PV. Motions are grouped under a plenary via motions.plenary_id
-- so the agenda/sommaire can list "Plénière N -> its motions" and the PV
-- body can repeat the équipe + agenda mini-block per plénière.
create table if not exists portal_assembly_plenaries (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  position integer not null default 0,
  label text not null default 'Plénière',
  starts_at_text text,
  closes_at_text text,
  president_name text,
  vice_president_name text,
  secretaries text,
  cscy_name text,
  cf_name text,
  created_at timestamptz not null default now(),
  unique (assembly_id, position)
);
create index if not exists idx_portal_assembly_plenaries_assembly on portal_assembly_plenaries(assembly_id, position);

alter table portal_assembly_motions add column if not exists plenary_id uuid references portal_assembly_plenaries(id) on delete set null;

-- =======================================================================
-- PI (POINT D'INTERVENTION) BOXES (PHASE 7)
-- =======================================================================
-- The boxed "PI: <name> (<role>)" callouts scattered through the paper PV,
-- attached to a motion (or standalone / attached to a plenary). member_id
-- is nullable — if the person has a portal account we look their role up
-- automatically, otherwise role_label is free text.
create table if not exists portal_assembly_pi (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  motion_id uuid references portal_assembly_motions(id) on delete cascade,
  plenary_id uuid references portal_assembly_plenaries(id) on delete set null,
  member_id uuid references portal_members(id) on delete set null,
  display_name text not null,
  role_label text,
  body text not null,
  position integer not null default 0,
  created_by uuid references portal_members(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_assembly_pi_assembly on portal_assembly_pi(assembly_id, motion_id);

-- =======================================================================
-- GROUND RULES (PHASE 7)
-- =======================================================================
-- One optional ground-rules block per assembly: a short intro plus an
-- ordered list of rules, presented at the top of the plénière.
create table if not exists portal_assembly_ground_rules (
  assembly_id uuid primary key references portal_assemblies(id) on delete cascade,
  intro text,
  rules jsonb not null default '[]'::jsonb,
  updated_by uuid references portal_members(id),
  updated_at timestamptz not null default now()
);

-- =======================================================================
-- MOUVEMENTS & CHANGEMENT DE REPRÉSENTANT (PHASE 7)
-- =======================================================================
-- Free-running log of "Nom et prénom / Statut-Club / Mouvement (Sortie ou
-- Entrée) / Heure" rows exactly like the attached screenshot, plus
-- "changement de représentant" — swapping which BEL member represents a
-- club already marked présent, without touching attendance/vote rows.
create table if not exists portal_assembly_movements (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  movement_type text not null check (movement_type in ('sortie', 'entree', 'changement_representant')),
  member_id uuid references portal_members(id) on delete set null,
  display_name text not null,
  status_club text,
  school_id integer references portal_schools(id) on delete set null,
  previous_representative_name text,
  occurred_at_text text not null,
  created_by uuid references portal_members(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_assembly_movements_assembly on portal_assembly_movements(assembly_id, created_at);

-- =======================================================================
-- PER-ASSEMBLY PRÉSENCE / VOTE FOR BEN·SUPCO, CNS, MEMBRES NATIONAUX (PHASE 7.1)
-- =======================================================================
-- The paper PV gives each of these three rosters its own real Présent/Absent
-- toggle (and, for CNS/membres nationaux, a Droit de vote toggle) scoped to
-- the assembly being minuted — not a static club-membership fact. One row
-- per (assembly, member); missing rows default to Absent/Non votant when
-- rendered, same convention as portal_assembly_club_attendance.
create table if not exists portal_assembly_roster_presence (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references portal_assemblies(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  roster text not null check (roster in ('ben', 'cns', 'formateurs', 'membres_nationaux')),
  attendance_status text not null default 'absent' check (attendance_status in ('present','absent')),
  voting_status text not null default 'non_votant' check (voting_status in ('votant','non_votant')),
  assigned_by uuid references portal_members(id),
  updated_at timestamptz not null default now(),
  unique (assembly_id, member_id, roster)
);
create index if not exists idx_portal_assembly_roster_presence_assembly on portal_assembly_roster_presence(assembly_id, roster);

-- =======================================================================
-- REUNION PV SILHOUETTE — "durée réelle", "conduites à tenir et
-- échéances" and "fichiers joints" per agenda point (PHASE 8)
-- =======================================================================
-- The simple réunion PV (distinct from the AL/AG assembly PV) tracks, per
-- agenda point: the point and its estimated duration (title/duration_minutes,
-- already present), the actual time it took, the follow-up actions and their
-- deadlines, and any files attached to that point. Nullable/optional so the
-- richer assembly PV (which also reuses this table via portal_minutes) is
-- unaffected.
alter table portal_minutes_agenda_blocks add column if not exists actual_duration_minutes integer;
alter table portal_minutes_agenda_blocks add column if not exists next_steps text;
alter table portal_minutes_agenda_blocks add column if not exists attachments jsonb not null default '[]'::jsonb;

-- =======================================================================
-- SECRÉTAIRE LOCAL — ANNONCES, ADOPTION DES PV, ARCHIVES DU CLUB (PHASE 9)
-- =======================================================================
alter table portal_meetings add column if not exists announced_at timestamptz;
alter table portal_meetings add column if not exists announcement_status text not null default 'draft';
alter table portal_meetings add column if not exists is_extraordinary boolean not null default false;

alter table portal_minutes add column if not exists adoption_meeting_id uuid references portal_meetings(id) on delete set null;
alter table portal_minutes add column if not exists adopted_at timestamptz;

create table if not exists portal_club_archives (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  category text not null check (category in ('pv', 'plan_action', 'rapport', 'decision', 'convention', 'autre')),
  title text not null,
  mandate text not null,
  document_url text,
  content_summary text,
  file_name text,
  file_size integer,
  archived_by uuid not null references portal_members(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_club_archives_school on portal_club_archives(school_id, mandate);
create index if not exists idx_portal_club_archives_category on portal_club_archives(school_id, category);

-- =======================================================================
-- TRÉSORIER LOCAL — GRAND LIVRE, COTISATIONS, VIREMENTS (PHASE 10)
-- =======================================================================

create table if not exists portal_treasury_transactions (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  transaction_date date not null,
  type text not null check (type in ('credit', 'debit')),
  amount numeric(12, 3) not null,
  description text not null,
  category text not null,
  receipt_url text,
  recorded_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_treasury_transactions_school on portal_treasury_transactions(school_id, transaction_date desc);

create table if not exists portal_club_dues (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  member_id uuid not null references portal_members(id) on delete cascade,
  season text not null,
  amount numeric(12, 3) not null,
  payment_date date,
  receipt_serial text unique,
  recorded_by uuid references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id, season)
);
create index if not exists idx_portal_club_dues_school on portal_club_dues(school_id, season);

create table if not exists portal_treasury_transfers (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  transfer_date date not null,
  amount numeric(12, 3) not null,
  destination text not null check (destination in ('national_bank', 'post_office')),
  receipt_url text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  recorded_by uuid not null references portal_members(id),
  verified_by uuid references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_treasury_transfers_school on portal_treasury_transfers(school_id, transfer_date desc);

-- =======================================================================
-- SECRÉTARIAT LOCAL — CARNET DES POINTS SUSPENDUS DE RÉUNION
-- =======================================================================
create table if not exists portal_suspended_points (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  meeting_id uuid references portal_meetings(id) on delete set null,
  title text not null,
  notes text,
  status text not null default 'pending' check (status in ('pending', 'included_in_agenda', 'resolved')),
  recorded_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_suspended_points_school on portal_suspended_points(school_id, status);

-- =======================================================================
-- POSTES LOCAUX (BEL) — VPI / VPE / VPC + SUPCO LOCAL
-- =======================================================================
-- The règlement (Septembre 2026) seats SIX posts on every Bureau Exécutif
-- Local (RI I.1.12): président, secrétaire général, trésorier, VPI, VPE,
-- VPC. Three of them (VPI/VPE/VPC) had no data model at all before this
-- block, so their statutory duties had nowhere to live. Each table below
-- maps to a specific article rather than being a generic "notes" bucket.
--
-- The SupCo Local (RI II.1.6, three members) is also added as a real
-- display role: it was previously only reachable through the
-- supervision_editor / cscy_reviewer capabilities, which meant a club
-- could not record WHO sits on its Conseil de Supervision, only who may
-- act. Statut ch. IV.3 makes SupCo membership a responsabilité, i.e. a
-- seat — so it belongs in portal_club_display_roles like the BEL posts.
do $$
begin
  alter table portal_club_display_roles drop constraint if exists portal_club_display_roles_role_check;
  alter table portal_club_display_roles add constraint portal_club_display_roles_role_check
    check (role in ('president', 'tresorier', 'secretaire', 'vpi', 'vpe', 'vpc', 'supco_regional', 'supco_local'));
exception when duplicate_object then null;
end $$;

-- The Annexe du système de mise à jour names report types the original
-- seven-value enum could not express (plan d'action annuel, avancement
-- stratégique, bilan financier, plan/bilan médiatique, pré/post
-- délégation, recommandation des parrains, identification des besoins).
-- Widening the CHECK is what lets every statutory local report exist as
-- a real row instead of being crammed into 'mise_a_jour'.
do $$
begin
  alter table portal_reports drop constraint if exists portal_reports_report_type_check;
  alter table portal_reports add constraint portal_reports_report_type_check
    check (report_type in (
      'pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation',
      'plan_action','avancement_strategique','bilan_financier','plan_mediatique','bilan_mediatique',
      'pre_delegation','post_delegation','partenariat','recommandation_parrains','identification_besoins'
    ));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table portal_report_templates drop constraint if exists portal_report_templates_report_type_check;
  alter table portal_report_templates add constraint portal_report_templates_report_type_check
    check (report_type in (
      'pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation',
      'plan_action','avancement_strategique','bilan_financier','plan_mediatique','bilan_mediatique',
      'pre_delegation','post_delegation','partenariat','recommandation_parrains','identification_besoins'
    ));
exception when duplicate_object then null;
end $$;

-- Which BEL post owns each report, so a role workspace can list "the
-- reports I am statutorily responsible for" without hardcoding the map
-- in every page. Null = not owned by a single local post.
alter table portal_report_templates add column if not exists owner_role text;
alter table portal_report_templates add column if not exists scope text not null default 'local';

-- ---- VPI (Relations Internes / RH) — RI I.7.2, I.7.7 ------------------
-- 7.7.2: "Préalablement à toute ouverture de recrutement, le VPI
-- détermine les critères de recrutement, les critères d'évaluation sur
-- lesquels les parrains fondent leur validation, ainsi que la durée de
-- la période d'essai." Those three things are columns, not prose: the
-- ALOV that closes a campaign needs them to judge the parrains' report.
create table if not exists portal_club_recruitment (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  title text not null,
  procedure text not null default 'recrutement' check (procedure in ('recrutement', 'parrainage', 'transfert')),
  recruitment_criteria text,
  evaluation_criteria text,
  trial_period_days integer,
  opens_on date,
  closes_on date,
  -- 7.7.3: the campaign ends at an ALOV where the parrains' report is
  -- put to adoption, hence the explicit 'alov_pending' state.
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'alov_pending', 'validated', 'cancelled')),
  needs_justification text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_club_recruitment_school on portal_club_recruitment(school_id, status);

-- 7.2.3 / 7.3.2.2: the club identifies a development need and sends a
-- request to the regional internal-affairs officer, or to the VPA when
-- the regional system is not active (RI I.1.38).
create table if not exists portal_club_needs (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  title text not null,
  need_type text not null default 'formation' check (need_type in ('formation', 'developpement', 'bien_etre', 'materiel', 'autre')),
  description text,
  target_audience text,
  -- 7.3.2.2 routes local needs to the RR chargé des affaires internes if
  -- one exists, else the VPA. Stored so the club can prove where it sent it.
  sent_to text not null default 'vpa' check (sent_to in ('vpa', 'responsable_regional')),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'refused', 'fulfilled')),
  response_note text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_club_needs_school on portal_club_needs(school_id, status);

-- ---- VPE (Relations Externes) — RI I.8.2, I.8.4 ----------------------
-- 8.4.2 distinguishes four kinds of external relation with different
-- rules, so 'relation_type' is a constrained enum rather than free text:
-- 8.4.2.6 requires the partenariat report to be adopted in an AL BEFORE
-- the relation is official, which is what 'al_pending' encodes.
create table if not exists portal_club_partnerships (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  partner_name text not null,
  relation_type text not null check (relation_type in ('collaboration', 'partenariat', 'sponsoring', 'arrangement')),
  description text,
  -- 8.4.2.4.1-2: research the need, then analyse the relation's impact
  -- against the needs previously set (the "étude ANVI" of 8.4.1.2.2).
  needs_analysis text,
  contract_url text,
  starts_on date,
  ends_on date,
  status text not null default 'draft' check (status in ('draft', 'vpe_review', 'al_pending', 'active', 'dissolved', 'refused')),
  -- 8.4.2.5: locally, nothing is official until the VPE validates.
  vpe_validated_at timestamptz,
  dissolution_note text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_club_partnerships_school on portal_club_partnerships(school_id, status);

-- 8.4.1.2: a délégation has a fixed timeline — the ANVI study and the
-- delegate-selection criteria land 7 days before, the delegates
-- themselves 4 days before. Both dates are stored so the deadlines can
-- be checked instead of trusted.
create table if not exists portal_club_delegations (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  title text not null,
  delegation_type text not null default 'locale' check (delegation_type in ('locale', 'par_domaine')),
  host_organisation text,
  happens_on date,
  anvi_study text,
  selection_criteria text,
  criteria_published_on date,
  delegates_selected_on date,
  status text not null default 'draft' check (status in ('draft', 'study', 'open', 'delegates_selected', 'completed', 'cancelled')),
  followup_note text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_club_delegations_school on portal_club_delegations(school_id, status);

-- ---- VPC (Communication Médiatique) — RI I.9.2, I.9.4 ----------------
-- 9.4.1.3 requires a plan médiatique BEFORE every activity and 9.4.1.4 a
-- bilan médiatique AFTER it, so one row per (activity, document kind).
-- 9.4.1.5 splits the médiatisation itself into three phases, and
-- 9.4.3.4 lists the validity criteria a content must satisfy — kept as
-- explicit booleans so the VPC can self-check before publishing.
create table if not exists portal_club_media_plans (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  activity_title text not null,
  project_id uuid references portal_projects(id) on delete set null,
  document_kind text not null default 'plan' check (document_kind in ('plan', 'bilan')),
  phase text not null default 'pre' check (phase in ('pre', 'pendant', 'post')),
  -- 9.4.1.6-7: external (digital / mass) vs internal (AYC website).
  reach text not null default 'externe' check (reach in ('externe', 'interne')),
  channel text not null default 'reseaux_sociaux' check (channel in ('reseaux_sociaux', 'site_web', 'television', 'radio', 'papeterie', 'autre')),
  content_type text not null default 'audiovisuel' check (content_type in ('audiovisuel', 'textuel')),
  summary text,
  -- 9.4.3.4.1.1 / 9.4.1.9: logo + identité visuelle conformity.
  identity_compliant boolean not null default false,
  logo_present boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'planned', 'published', 'archived')),
  published_on date,
  metrics text,
  created_by uuid not null references portal_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_club_media_plans_school on portal_club_media_plans(school_id, document_kind, status);

-- ---- Report templates for the statutory local reports ----------------
-- Sourced one-for-one from the Annexe du système de mise à jour (I.1.1,
-- I.1.3, I.1.4, I.3.1.1, I.5.1.1, I.6.1.1, 3.1.3) plus the VPE/VPC
-- reports named in RI I.8.4.2.4.4, I.8.4.4.5 and I.9.4.1.3-4.
-- 'default_due_days' is negative when the deadline falls BEFORE the
-- event (the existing pre_projet row already uses that convention).
insert into portal_report_templates
  (slug, name, report_type, description, recipient, deadline_rule, default_due_days, required_sections, validator_departments, owner_role, scope)
values
  ('plan_action_local', 'Rapport du plan d''action annuel du club', 'plan_action',
   'Plan d''action annuel adopté à l''ALOFM (RI I.4.3.1.6). Rédigé par le président avec les parties de chaque membre du BEL.',
   'Bureau Exécutif National', '7 jours après l''élection du BEL', 7,
   '["methode_implementation", "methodologies_objectifs", "projets_phares", "budget_et_fonds", "methode_evaluation"]'::jsonb,
   '["coordination_strategique"]'::jsonb, 'president', 'local'),

  ('avancement_strategique_local', 'Rapport d''avancement stratégique local', 'avancement_strategique',
   'Évaluation de l''avancement tactique du club (RI I.4.3.2.3), présentée à l''ALOFM.',
   'CSCY local', '5 jours avant la première plénière de l''ALOFM', -5,
   '["rappel_objectifs", "avancement_par_objectif", "ecarts", "evaluation", "recommandations"]'::jsonb,
   '["coordination_strategique"]'::jsonb, 'president', 'local'),

  ('bilan_financier_local', 'Bilan financier de mise à jour local', 'bilan_financier',
   'Mise à jour de toutes les transactions du club (Annexe I.5.1.1). Non adopté à l''ALOFM ⇒ investigation du SupCo Local (RI I.1.19).',
   'CSCY local', '5 jours avant la première plénière de l''ALOFM', -5,
   '["situation_caisse", "encaissements", "decaissements", "cotisations", "dettes_et_creances", "justificatifs"]'::jsonb,
   '["tresorerie"]'::jsonb, 'tresorier', 'local'),

  ('identification_besoins_local', 'Rapport d''identification des besoins', 'identification_besoins',
   'Besoin de développement identifié par le club, adressé au RR chargé des affaires internes ou au VPA (RI I.7.3.2.2).',
   'VPA / Responsable Régional', 'Selon le système de mise à jour', -7,
   '["besoin_identifie", "public_concerne", "justification", "resultat_attendu"]'::jsonb,
   '["coordination_strategique"]'::jsonb, 'vpi', 'local'),

  ('recommandation_parrains', 'Rapport de recommandation des parrains', 'recommandation_parrains',
   'Recommandation des parrains sur chaque nouveau membre, soumise à l''adoption en ALOV (RI I.7.7.3-4).',
   'CSCY local', '5 jours avant l''ALOV', -5,
   '["nouveaux_membres", "criteres_evaluation", "evaluation_individuelle", "recommandation"]'::jsonb,
   '["coordination_strategique"]'::jsonb, 'vpi', 'local'),

  ('partenariat_local', 'Rapport de partenariat local', 'partenariat',
   'Rapport de partenariat à adopter en AL avant d''officialiser la relation (RI I.8.4.2.6).',
   'Assemblée Locale', 'Avant l''officialisation de la relation', -5,
   '["partenaire", "besoin_et_recherche", "analyse_impact", "clauses", "engagements", "suite"]'::jsonb,
   '["relations_exterieures", "coordination_strategique"]'::jsonb, 'vpe', 'local'),

  ('pre_delegation_local', 'Rapport pré-délégation', 'pre_delegation',
   'Étude ANVI et critères de sélection des délégués (RI I.8.4.1.2.2, I.8.4.4.5.1).',
   'VPE / VPR', '7 jours avant la délégation', -7,
   '["opportunite", "etude_anvi", "criteres_selection", "encadrement_prevu"]'::jsonb,
   '["relations_exterieures"]'::jsonb, 'vpe', 'local'),

  ('post_delegation_local', 'Rapport post-délégation', 'post_delegation',
   'Suivi et évaluation post-session de la délégation (RI I.8.4.1.2.6, I.8.4.4.5.2).',
   'VPE / VPR', '10 jours après la délégation', 10,
   '["deroulement", "delegues", "acquis", "evaluation", "suivi"]'::jsonb,
   '["relations_exterieures"]'::jsonb, 'vpe', 'local'),

  ('plan_mediatique_local', 'Plan médiatique', 'plan_mediatique',
   'Planification médiatique établie AVANT chaque activité (RI I.9.4.1.3).',
   'Responsable Régional Communication / VPCom', 'Avant le début de l''activité', -7,
   '["objectif_communication", "public_cible", "canaux", "calendrier", "contenus_prevus", "identite_visuelle"]'::jsonb,
   '["communication"]'::jsonb, 'vpc', 'local'),

  ('bilan_mediatique_local', 'Bilan médiatique', 'bilan_mediatique',
   'Bilan de la médiatisation effectuée APRÈS chaque activité (RI I.9.4.1.4).',
   'Responsable Régional Communication / VPCom', 'Après la fin de l''activité', 10,
   '["contenus_publies", "portee_et_engagement", "ecarts_au_plan", "conformite_identite", "recommandations"]'::jsonb,
   '["communication"]'::jsonb, 'vpc', 'local')
on conflict (slug) do nothing;

-- Attribute the pre-existing templates to their owning local post so the
-- role workspaces can filter on owner_role uniformly.
update portal_report_templates set owner_role = 'president' where slug in ('pre_projet', 'post_projet') and owner_role is null;
update portal_report_templates set owner_role = 'secretaire' where slug = 'proces_verbal' and owner_role is null;
update portal_report_templates set owner_role = 'vpe' where slug = 'collaboration' and owner_role is null;

-- =======================================================================
-- OFFICIAL REPORT TEMPLATES — sourced verbatim from the Annexe du système
-- de mise à jour (Règlement AYC, Septembre 2026). These carry the full
-- nested structure of the official documents (sections, sub-sections,
-- tables, checklists) in `schema_json`, rendered recursively by
-- report-editor.html, instead of the flat `required_sections` list used
-- by the earlier hand-authored templates above. `required_sections` is
-- kept populated too (top-level section keys only) so any code that
-- still reads it (e.g. the reports list summary) keeps working.
-- 'is_form' flags the two Google-Form-style national submissions
-- (amendments / procedural motions), which have no deadline countdown
-- tied to a club event.
-- =======================================================================
alter table portal_report_templates add column if not exists schema_json jsonb;
alter table portal_report_templates add column if not exists is_form boolean not null default false;
alter table portal_report_templates add column if not exists utilise_par jsonb not null default '[]'::jsonb;

do $$
begin
  alter table portal_reports drop constraint if exists portal_reports_report_type_check;
  alter table portal_reports add constraint portal_reports_report_type_check
    check (report_type in (
      'pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation',
      'plan_action','avancement_strategique','bilan_financier','plan_mediatique','bilan_mediatique',
      'pre_delegation','post_delegation','partenariat','recommandation_parrains','identification_besoins',
      'annonce_reunion','recommandation_vpa','amendement','motion_procedurale','pv_assemblee','cscy_final'
    ));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table portal_report_templates drop constraint if exists portal_report_templates_report_type_check;
  alter table portal_report_templates add constraint portal_report_templates_report_type_check
    check (report_type in (
      'pre_projet','post_projet','proces_verbal','collaboration','mise_a_jour','supervision','investigation',
      'plan_action','avancement_strategique','bilan_financier','plan_mediatique','bilan_mediatique',
      'pre_delegation','post_delegation','partenariat','recommandation_parrains','identification_besoins',
      'annonce_reunion','recommandation_vpa','amendement','motion_procedurale','pv_assemblee','cscy_final'
    ));
exception when duplicate_object then null;
end $$;

insert into portal_report_templates
  (slug, name, report_type, description, recipient, deadline_rule, default_due_days, required_sections, validator_departments, owner_role, scope, is_form, utilise_par, schema_json)
values
  ('mise_a_jour_officielle', 'Rapport de Mise à jour', 'mise_a_jour',
   'Rapport périodique de mandat (instruction, prise de fonction, passation, encadrement) exigé de chaque responsable BEL/BEN/SupCo (Annexe I.1.1).',
   'CSCY (local ou national selon l''échelle)', '5 jours avant l''ALOFM (local) / 5 jours avant la 1ère plénière de chaque AG ordinaire (national)', -5,
   '["I_Contextualisation", "II_Sommaire", "tableau_phases"]'::jsonb, '["coordination_strategique", "secretariat"]'::jsonb,
   null, 'local', false, '["BEL (chaque responsable)", "BEN (chaque responsable)", "SupCo (chaque responsable)"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_du_redacteur", "label": "Nom du redacteur"}, {"type": "text", "key": "Departement", "label": "Departement"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_ordinaire_visee", "label": "Assemblee ordinaire visee"}]}, {"type": "section", "key": "II_Sommaire", "label": "Sommaire", "children": [{"type": "section", "key": "1_Les_phases", "label": "Les phases", "children": [{"type": "text", "key": "a_instruction", "label": "Instruction"}, {"type": "text", "key": "b_prise_de_fonction", "label": "Prise de fonction"}, {"type": "text", "key": "c_passation", "label": "Passation"}, {"type": "text", "key": "d_encadrement", "label": "Encadrement"}]}, {"type": "text", "key": "2_L_attente_des_objectifs", "label": "L attente des objectifs"}, {"type": "text", "key": "3_Chronologie_des_methodologies", "label": "Chronologie des methodologies"}, {"type": "text", "key": "4_L_implementation_de_chaque_methodologie", "label": "L implementation de chaque methodologie"}, {"type": "text", "key": "5_L_evaluation_de_chaque_methodologie", "label": "L evaluation de chaque methodologie"}, {"type": "text", "key": "6_Auto_evaluation", "label": "Auto evaluation"}, {"type": "text", "key": "7_Recommandations", "label": "Recommandations"}]}, {"type": "table", "key": "tableau_phases", "label": "Tableau phases", "columns": [{"key": "les_phases", "label": "Les phases"}, {"key": "atteinte_des_objectifs", "label": "Atteinte des objectifs"}, {"key": "chronologie_des_methodes", "label": "Chronologie des methodes"}, {"key": "implementation_de_chaque_methode", "label": "Implementation de chaque methode"}, {"key": "evaluation_de_chaque_methodologie", "label": "Evaluation de chaque methodologie"}], "presetRows": ["Instruction", "Prise de fonction", "Passation", "Encadrement"]}, {"type": "text", "key": "auto_evaluation", "label": "Auto evaluation"}, {"type": "text", "key": "recommandations", "label": "Recommandations"}]}$tpl$::jsonb),

  ('pre_projet_officiel', 'Rapport pré-projet', 'pre_projet',
   'Rapport détaillé à préparer avant le premier engagement externe d''un projet (Annexe I.3.1.1).',
   'Président National (local) / Tout le monde (national)', '7 jours avant le premier engagement externe', -7,
   '["I_Contextualisation", "II_Le_rapport"]'::jsonb, '["coordination_strategique", "tresorerie"]'::jsonb,
   'president', 'local', false, '["BEL (Président Local)", "BEN (Président National)"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_de_l_entite", "label": "Nom de l entite", "placeholder": "Club / BEN"}, {"type": "text", "key": "Redacteurs", "label": "Redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Type_du_projet", "label": "Type du projet", "placeholder": "delegation / evenement (interne et externe) / recrutement / campagne mediatique"}]}, {"type": "section", "key": "II_Le_rapport", "label": "Le rapport", "children": [{"type": "section", "key": "1_Coordination_strategique", "label": "Coordination strategique", "children": [{"type": "section", "key": "place_dans_la_strategie", "label": "Place dans la strategie", "children": [{"type": "text", "key": "buts_strategiques", "label": "Buts strategiques"}, {"type": "text", "key": "parties_prenantes", "label": "Parties prenantes"}, {"type": "text", "key": "resultats_attendus", "label": "Resultats attendus"}]}, {"type": "table", "key": "repartition_des_taches", "label": "Repartition des taches", "columns": [{"key": "executeur", "label": "Executeur"}, {"key": "tache", "label": "Tache"}, {"key": "delais", "label": "Delais"}], "presetRows": []}, {"type": "table", "key": "systeme_evaluation_impact", "label": "Systeme evaluation impact", "columns": [{"key": "marqueurs_d_evaluation_de_la_strategie", "label": "Marqueurs d evaluation de la strategie"}, {"key": "methodes_a_utiliser", "label": "Methodes a utiliser"}], "presetRows": []}]}, {"type": "section", "key": "2_Secretariat", "label": "Secretariat", "children": [{"type": "section", "key": "informations_generales_sur_le_projet", "label": "Informations generales sur le projet", "children": [{"type": "text", "key": "titre_du_projet", "label": "Titre du projet"}, {"type": "text", "key": "date_du_projet", "label": "Date du projet"}, {"type": "text", "key": "lieu_du_projet", "label": "Lieu du projet"}, {"type": "text", "key": "type_du_projet", "label": "Type du projet"}, {"type": "text", "key": "estimation_nombre_de_participants", "label": "Estimation nombre de participants"}, {"type": "text", "key": "justification", "label": "Justification"}]}, {"type": "table", "key": "deroulement_du_programme_planifie", "label": "Deroulement du programme planifie", "columns": [{"key": "jour", "label": "Jour"}, {"key": "horaire", "label": "Horaire"}, {"key": "programme", "label": "Programme"}], "presetRows": []}, {"type": "section", "key": "documents_soumis_si_besoin", "label": "Documents soumis si besoin", "children": [{"type": "text", "key": "besoin_du_document", "label": "Besoin du document"}, {"type": "text", "key": "titre_du_document", "label": "Titre du document"}, {"type": "text", "key": "contenu_du_document", "label": "Contenu du document"}]}, {"type": "text", "key": "demande_officielle", "label": "Demande officielle"}, {"type": "section", "key": "autorisation_parentale", "label": "Autorisation parentale", "children": [{"type": "text", "key": "nom_parent", "label": "Nom parent"}, {"type": "text", "key": "cin_parent", "label": "Cin parent"}, {"type": "text", "key": "nom_enfant", "label": "Nom enfant"}, {"type": "text", "key": "date_naissance_enfant", "label": "Date naissance enfant"}, {"type": "text", "key": "lieu_naissance_enfant", "label": "Lieu naissance enfant"}, {"type": "text", "key": "age", "label": "Age"}, {"type": "text", "key": "nom_projet", "label": "Nom projet"}, {"type": "text", "key": "club_organisateur", "label": "Club organisateur"}, {"type": "text", "key": "date_debut", "label": "Date debut"}, {"type": "text", "key": "date_fin", "label": "Date fin"}, {"type": "text", "key": "lieu", "label": "Lieu"}], "note": "Cette autorisation doit etre legalisee a la municipalite"}, {"type": "section", "key": "guide_de_projet", "label": "Guide de projet", "children": [{"type": "text", "key": "titre_du_guide", "label": "Titre du guide"}, {"type": "text", "key": "sommaire", "label": "Sommaire"}, {"type": "section", "key": "invitation", "label": "Invitation", "children": [{"type": "text", "key": "date", "label": "Date"}, {"type": "text", "key": "localisation", "label": "Localisation"}]}, {"type": "section", "key": "introduction", "label": "Introduction", "children": [{"type": "text", "key": "description", "label": "Description"}, {"type": "text", "key": "le_besoin", "label": "Le besoin"}, {"type": "text", "key": "la_finalite", "label": "La finalite"}, {"type": "text", "key": "les_objectifs", "label": "Les objectifs"}]}, {"type": "text", "key": "programme", "label": "Programme"}, {"type": "section", "key": "participation", "label": "Participation", "children": [{"type": "text", "key": "qui_sont_les_participants", "label": "Qui sont les participants"}, {"type": "text", "key": "comment_participer", "label": "Comment participer"}, {"type": "text", "key": "frais_et_packs", "label": "Frais et packs"}, {"type": "text", "key": "paiement", "label": "Paiement"}]}, {"type": "table", "key": "contact", "label": "Contact", "columns": [{"key": "type_de_participation", "label": "Type de participation"}, {"key": "nom_de_l_organisation", "label": "Nom de l organisation"}, {"key": "adresse_e_mail", "label": "Adresse e mail"}, {"key": "numero_de_telephone", "label": "Numero de telephone"}], "presetRows": []}]}, {"type": "text", "key": "autres_remarques", "label": "Autres remarques"}]}, {"type": "section", "key": "3_Ressources_humaines", "label": "Ressources humaines", "children": [{"type": "text", "key": "accompagnement_des_adherents", "label": "Accompagnement des adherents"}, {"type": "list", "key": "besoins", "label": "Besoins", "options": ["Recrutement", "Integration", "Motivation", "Instruction", "Implication", "Fidelisation", "Soutien", "Reconnaissance"]}, {"type": "text", "key": "objectifs", "label": "Objectifs"}, {"type": "text", "key": "methodologie", "label": "Methodologie"}, {"type": "text", "key": "implementation", "label": "Implementation"}, {"type": "text", "key": "evaluation", "label": "Evaluation"}]}, {"type": "section", "key": "4_Relations_externes", "label": "Relations externes", "children": [{"type": "section", "key": "evaluation_anvi", "label": "Evaluation anvi", "children": [{"type": "text", "key": "apprentissage_academique", "label": "Apprentissage academique"}, {"type": "text", "key": "apprentissage_organisationnel", "label": "Apprentissage organisationnel"}, {"type": "text", "key": "notoriete_visibilite", "label": "Notoriete visibilite"}, {"type": "text", "key": "notoriete_influence", "label": "Notoriete influence"}]}, {"type": "section", "key": "type_de_relation", "label": "Type de relation", "children": [{"type": "text", "key": "nature", "label": "Nature"}, {"type": "list", "key": "types", "label": "Types", "options": ["Collaborateur", "Partenaire", "Academique/Organisationnel", "Sponsoring", "Donation"]}], "note": "Ne pas cocher si le projet est une delegation"}, {"type": "section", "key": "presentation_collaborateurs", "label": "Presentation collaborateurs", "children": [{"type": "text", "key": "type_de_collaborateur", "label": "Type de collaborateur"}, {"type": "text", "key": "historique", "label": "Historique"}, {"type": "text", "key": "vision_mission", "label": "Vision mission"}, {"type": "text", "key": "repartition_geographique", "label": "Repartition geographique"}, {"type": "text", "key": "nom_du_contact", "label": "Nom du contact"}, {"type": "text", "key": "adresse_mail", "label": "Adresse mail"}, {"type": "text", "key": "numero_de_telephone", "label": "Numero de telephone"}]}, {"type": "text", "key": "documents_pdf_certifiants_legalite", "label": "Documents pdf certifiants legalite"}, {"type": "text", "key": "marqueurs_d_evaluation", "label": "Marqueurs d evaluation"}, {"type": "section", "key": "contrat_final", "label": "Contrat final", "children": [{"type": "text", "key": "duree_de_la_collaboration", "label": "Duree de la collaboration"}, {"type": "text", "key": "obligations_association", "label": "Obligations association"}, {"type": "text", "key": "obligations_partie_externe", "label": "Obligations partie externe"}, {"type": "text", "key": "date_debut", "label": "Date debut"}, {"type": "text", "key": "conditions_resiliation", "label": "Conditions resiliation"}, {"type": "text", "key": "conditions_modification", "label": "Conditions modification"}, {"type": "text", "key": "clause_confidentialite", "label": "Clause confidentialite"}, {"type": "text", "key": "clause_litiges", "label": "Clause litiges"}, {"type": "text", "key": "juridiction_competente", "label": "Juridiction competente", "placeholder": "Tunis"}], "note": "Ne pas remplir si le projet est une delegation"}, {"type": "section", "key": "modele_dossier_sponsoring", "label": "Modele dossier sponsoring", "children": [{"type": "section", "key": "presentation_association", "label": "Presentation association", "children": [{"type": "text", "key": "vision", "label": "Vision"}, {"type": "text", "key": "axes", "label": "Axes"}, {"type": "text", "key": "mission", "label": "Mission"}, {"type": "text", "key": "structures", "label": "Structures"}, {"type": "text", "key": "valeurs", "label": "Valeurs"}]}, {"type": "section", "key": "presentation_youth_club_local", "label": "Presentation youth club local", "children": [{"type": "text", "key": "presentation_du_club", "label": "Presentation du club"}, {"type": "text", "key": "communaute_educative_et_impact", "label": "Communaute educative et impact"}, {"type": "text", "key": "anciens_evenements", "label": "Anciens evenements"}, {"type": "text", "key": "equipe", "label": "Equipe"}]}, {"type": "section", "key": "presentation_de_l_evenement", "label": "Presentation de l evenement", "children": [{"type": "text", "key": "description", "label": "Description"}, {"type": "text", "key": "date_et_lieu", "label": "Date et lieu"}, {"type": "text", "key": "programme", "label": "Programme"}]}, {"type": "section", "key": "pourquoi_devenir_partenaire", "label": "Pourquoi devenir partenaire", "children": [{"type": "text", "key": "image", "label": "Image"}, {"type": "text", "key": "cibles", "label": "Cibles"}, {"type": "text", "key": "medias", "label": "Medias"}, {"type": "text", "key": "partenariat", "label": "Partenariat"}]}, {"type": "text", "key": "estimation_budgetaire", "label": "Estimation budgetaire"}, {"type": "text", "key": "packs_de_sponsoring", "label": "Packs de sponsoring"}, {"type": "text", "key": "visibilite_offerte", "label": "Visibilite offerte"}]}]}, {"type": "section", "key": "5_Tresorerie", "label": "Tresorerie", "children": [{"type": "text", "key": "estimation_budgetaire", "label": "Estimation budgetaire"}]}, {"type": "section", "key": "6_Communication", "label": "Communication", "children": [{"type": "text", "key": "plan_mediatique", "label": "Plan mediatique"}]}]}]}$tpl$::jsonb),

  ('post_projet_officiel', 'Rapport post-projet', 'post_projet',
   'Bilan détaillé à transmettre après la fin d''un projet (Annexe I.3.1.1).',
   'Président National (local) / Tout le monde (national)', '10 jours après la fin du projet', 10,
   '["I_Contextualisation", "II_Le_rapport"]'::jsonb, '["coordination_strategique", "tresorerie"]'::jsonb,
   'president', 'local', false, '["BEL (Président Local)", "BEN (Président National)"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_de_l_entite", "label": "Nom de l entite"}, {"type": "text", "key": "Redacteurs", "label": "Redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Type_du_projet", "label": "Type du projet"}]}, {"type": "section", "key": "II_Le_rapport", "label": "Le rapport", "children": [{"type": "section", "key": "1_Coordination_strategique", "label": "Coordination strategique", "children": [{"type": "section", "key": "rappel_de_la_place_dans_la_strategie", "label": "Rappel de la place dans la strategie", "children": [{"type": "text", "key": "buts_strategiques", "label": "Buts strategiques"}, {"type": "text", "key": "parties_prenantes", "label": "Parties prenantes"}, {"type": "text", "key": "resultats_attendus", "label": "Resultats attendus"}]}, {"type": "section", "key": "informations_generales_finales", "label": "Informations generales finales", "children": [{"type": "text", "key": "titre_du_projet", "label": "Titre du projet"}, {"type": "text", "key": "date_du_projet", "label": "Date du projet"}, {"type": "text", "key": "lieu_du_projet", "label": "Lieu du projet"}, {"type": "text", "key": "type_du_projet", "label": "Type du projet"}, {"type": "text", "key": "nombre_de_participants", "label": "Nombre de participants"}, {"type": "text", "key": "liste_de_participation", "label": "Liste de participation"}]}, {"type": "section", "key": "evaluation_de_l_impact", "label": "Evaluation de l impact", "children": [{"type": "text", "key": "marqueurs_d_evaluation", "label": "Marqueurs d evaluation"}, {"type": "text", "key": "resultat_de_l_evaluation", "label": "Resultat de l evaluation"}]}]}, {"type": "section", "key": "2_Secretariat", "label": "Secretariat", "children": [{"type": "table", "key": "deroulement_exact_du_programme", "label": "Deroulement exact du programme", "columns": [{"key": "jour", "label": "Jour"}, {"key": "horaire", "label": "Horaire"}, {"key": "programme", "label": "Programme"}], "presetRows": []}, {"type": "table", "key": "evaluation_des_documents_soumis", "label": "Evaluation des documents soumis", "columns": [{"key": "document_soumis", "label": "Document soumis"}, {"key": "evaluation_de_fond", "label": "Evaluation de fond"}, {"key": "evaluation_de_forme", "label": "Evaluation de forme"}], "presetRows": []}]}, {"type": "section", "key": "3_Ressources_humaines", "label": "Ressources humaines", "children": [{"type": "text", "key": "accompagnement_des_adherents", "label": "Accompagnement des adherents"}, {"type": "list", "key": "besoins", "label": "Besoins", "options": ["Recrutement", "Integration", "Motivation", "Instruction", "Implication", "Fidelisation", "Soutien", "Reconnaissance"]}, {"type": "text", "key": "objectifs", "label": "Objectifs"}, {"type": "text", "key": "methodologie", "label": "Methodologie"}, {"type": "text", "key": "implementation", "label": "Implementation"}, {"type": "text", "key": "evaluation", "label": "Evaluation"}]}, {"type": "section", "key": "4_Relations_externes", "label": "Relations externes", "children": [{"type": "section", "key": "delegation", "label": "Delegation", "children": [{"type": "text", "key": "nom_de_l_evenement_et_de_l_organisateur", "label": "Nom de l evenement et de l organisateur"}, {"type": "text", "key": "nom_du_club", "label": "Nom du club"}, {"type": "text", "key": "redacteurs", "label": "Redacteurs"}, {"type": "text", "key": "date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "date_d_envoi", "label": "Date d envoi"}, {"type": "repeatable_group", "key": "delegues", "label": "Delegues", "itemFields": [{"type": "text", "key": "prenom_nom", "label": "Prenom nom"}, {"type": "text", "key": "contact", "label": "Contact"}], "presetRows": [{"prenom_nom": "", "contact": ""}]}, {"type": "section", "key": "evaluation_anvi", "label": "Evaluation anvi", "children": [{"type": "text", "key": "apprentissage_academique", "label": "Apprentissage academique"}, {"type": "text", "key": "apprentissage_organisationnel", "label": "Apprentissage organisationnel"}, {"type": "text", "key": "notoriete_visibilite", "label": "Notoriete visibilite"}, {"type": "text", "key": "notoriete_influence", "label": "Notoriete influence"}]}, {"type": "section", "key": "rapport_de_prise_de_note", "label": "Rapport de prise de note", "children": [{"type": "text", "key": "nom_de_l_intervenant", "label": "Nom de l intervenant"}, {"type": "text", "key": "points_forts_intervention", "label": "Points forts intervention"}, {"type": "text", "key": "points_faibles_intervention", "label": "Points faibles intervention"}, {"type": "text", "key": "recommandation_travailler_avec_lui", "label": "Recommandation travailler avec lui"}, {"type": "text", "key": "points_forts_evenement", "label": "Points forts evenement"}, {"type": "text", "key": "points_faibles_evenement", "label": "Points faibles evenement"}, {"type": "text", "key": "ressources_documents_partages", "label": "Ressources documents partages"}, {"type": "text", "key": "recommandation", "label": "Recommandation"}, {"type": "text", "key": "contrats_signes", "label": "Contrats signes"}]}]}, {"type": "section", "key": "rapport_d_evaluation_des_relations", "label": "Rapport d evaluation des relations", "children": [{"type": "text", "key": "mandat", "label": "Mandat"}, {"type": "text", "key": "nom_du_club", "label": "Nom du club"}, {"type": "text", "key": "redacteurs", "label": "Redacteurs"}, {"type": "text", "key": "date_de_redaction", "label": "Date de redaction"}, {"type": "section", "key": "evaluation_objectifs_anvi", "label": "Evaluation objectifs anvi", "children": [{"type": "text", "key": "apprentissage_academique", "label": "Apprentissage academique"}, {"type": "text", "key": "apprentissage_organisationnel", "label": "Apprentissage organisationnel"}, {"type": "text", "key": "notoriete_visibilite", "label": "Notoriete visibilite"}, {"type": "text", "key": "notoriete_influence", "label": "Notoriete influence"}]}, {"type": "section", "key": "type_de_relation", "label": "Type de relation", "children": [{"type": "text", "key": "nature", "label": "Nature"}, {"type": "list", "key": "types", "label": "Types", "options": ["Collaborateur", "Partenaire", "Academique/Organisationnel", "Sponsoring", "Donation"]}]}, {"type": "section", "key": "presentation_collaborateurs", "label": "Presentation collaborateurs", "children": [{"type": "text", "key": "type_de_collaborateur", "label": "Type de collaborateur"}, {"type": "text", "key": "historique", "label": "Historique"}, {"type": "text", "key": "vision_mission", "label": "Vision mission"}, {"type": "text", "key": "repartition_geographique", "label": "Repartition geographique"}, {"type": "text", "key": "nom_du_contact", "label": "Nom du contact"}, {"type": "text", "key": "adresse_mail", "label": "Adresse mail"}, {"type": "text", "key": "numero_de_telephone", "label": "Numero de telephone"}]}, {"type": "section", "key": "evaluation_respect_obligations", "label": "Evaluation respect obligations", "children": [{"type": "text", "key": "association_ou_club", "label": "Association ou club"}, {"type": "text", "key": "collaborateur", "label": "Collaborateur"}]}]}]}, {"type": "section", "key": "5_Tresorerie", "label": "Tresorerie", "children": [{"type": "text", "key": "bilan_financier", "label": "Bilan financier"}, {"type": "text", "key": "etude_d_ecart", "label": "Etude d ecart"}, {"type": "text", "key": "suivi_de_participation", "label": "Suivi de participation"}]}, {"type": "section", "key": "6_Communication", "label": "Communication", "children": [{"type": "text", "key": "bilan_mediatique_post_projet", "label": "Bilan mediatique post projet"}, {"type": "text", "key": "photos_captures_ecran", "label": "Photos captures ecran"}]}]}]}$tpl$::jsonb),

  ('plan_action_officiel', 'Rapport du Plan d''action annuel du Club', 'plan_action',
   'Plan d''action annuel détaillé par axe stratégique et par département, adopté à l''AGOFM (Annexe I.1.3).',
   'Bureau Exécutif National', 'Le BEL élu doit l''envoyer au plus tard 7 jours après son élection ; validation par le BEN à l''AGOFM', 7,
   '["I_Contextualisation", "II_Le_plan_d_action"]'::jsonb, '["coordination_strategique"]'::jsonb,
   'president', 'local', false, '["BEL"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_des_redacteurs", "label": "Nom des redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_visee", "label": "Assemblee visee"}]}, {"type": "table", "key": "II_Le_plan_d_action", "label": "Le plan d action", "columns": [{"key": "phase", "label": "Phase"}, {"key": "axe_de_la_strategie", "label": "Axe de la strategie"}, {"key": "buts_strategiques", "label": "Buts strategiques"}, {"key": "parties_prenantes", "label": "Parties prenantes"}, {"key": "resultats_attendus", "label": "Resultats attendus"}, {"key": "type_du_projet", "label": "Type du projet"}, {"key": "date_du_projet", "label": "Date du projet"}, {"key": "lieu_approximatif_du_projet", "label": "Lieu approximatif du projet"}, {"key": "taches_coordination_strategique", "label": "Taches coordination strategique"}, {"key": "taches_ressources_humaines", "label": "Taches ressources humaines"}, {"key": "taches_relations_externes", "label": "Taches relations externes"}, {"key": "taches_secretariat", "label": "Taches secretariat"}, {"key": "taches_tresorerie", "label": "Taches tresorerie"}, {"key": "taches_communication", "label": "Taches communication"}], "presetRows": [], "note": "Dans la colonne des axes strategiques, indiquez la raison pour laquelle votre communaute educative doit prioriser cet axe."}]}$tpl$::jsonb),

  ('avancement_strategique_officiel', 'Rapport d''Avancement Stratégique', 'avancement_strategique',
   'Suivi de l''avancement du plan stratégique par axe, présenté au CSCY (Annexe I.1.4).',
   'CSCY', '5 jours avant la 1ère plénière de l''ALOFM (local) / 10 jours avant le début de la 1ère plénière de chaque AG ordinaire (national)', -5,
   '["I_Contextualisation", "II_Sommaire"]'::jsonb, '["coordination_strategique"]'::jsonb,
   'president', 'local', false, '["Président Local", "Président National"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_de_redacteur", "label": "Nom de redacteur"}, {"type": "text", "key": "Nom_du_club", "label": "Nom du club"}, {"type": "text", "key": "Departement", "label": "Departement"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_generale_ordinaire_visee", "label": "Assemblee generale ordinaire visee"}]}, {"type": "table", "key": "II_Sommaire", "label": "Sommaire", "columns": [{"key": "axe", "label": "Axe"}, {"key": "but_strategique", "label": "But strategique"}, {"key": "partie_prenante", "label": "Partie prenante"}, {"key": "le_projet", "label": "Le projet"}, {"key": "club_organisateur", "label": "Club organisateur"}, {"key": "evaluation", "label": "Evaluation"}], "presetRows": [], "extra": {"recommandations": {"type": "text", "key": "recommandations", "label": "Recommandations"}}}]}$tpl$::jsonb),

  ('annonce_reunion', 'Annonce d''une réunion', 'annonce_reunion',
   'Formulaire d''annonce à envoyer avant toute réunion, avec ordre du jour et documents à présenter (Annexe I.6.1.1).',
   'Secrétaire Général (local) / SupCo National, BEN, EPN (national)', '72 heures (3 jours) avant le début de la réunion', -3,
   '["nom_complet_du_club", "date_de_la_reunion", "ordre_du_jour"]'::jsonb, '["secretariat"]'::jsonb,
   'secretaire', 'local', true, '["Secrétaire Local", "Secrétaire Général National"]'::jsonb,
   $tpl${"sections": [{"type": "text", "key": "nom_complet_du_club", "label": "Nom complet du club"}, {"type": "text", "key": "date_de_la_reunion", "label": "Date de la reunion"}, {"type": "text", "key": "lieu_de_la_reunion", "label": "Lieu de la reunion"}, {"type": "text", "key": "liste_des_participants", "label": "Liste des participants"}, {"type": "text", "key": "presidents_de_la_reunion", "label": "Presidents de la reunion"}, {"type": "text", "key": "heure_de_debut_de_la_reunion", "label": "Heure de debut de la reunion"}, {"type": "text", "key": "duree_estimee_de_la_reunion", "label": "Duree estimee de la reunion"}, {"type": "text", "key": "ordre_du_jour", "label": "Ordre du jour"}, {"type": "text", "key": "documents_a_presenter", "label": "Documents a presenter"}]}$tpl$::jsonb),

  ('pv_reunion_officiel', 'Procès-verbal (PV) d''une réunion', 'proces_verbal',
   'Procès-verbal structuré d''une réunion : présence, points à l''ordre du jour, discussions et décisions (Annexe I.6.1.1).',
   'Secrétaire Général', '72 heures (3 jours) après la fin de la réunion', 3,
   '["titre", "I_Contextualisation", "tableau_de_presence", "II_Le_Proces_Verbal"]'::jsonb, '["secretariat"]'::jsonb,
   'secretaire', 'local', false, '["Secrétaire Local", "Secrétaire Général National"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Organisateur_de_la_reunion", "label": "Organisateur de la reunion"}, {"type": "text", "key": "Date_de_la_reunion", "label": "Date de la reunion"}, {"type": "text", "key": "Lieu_de_la_reunion", "label": "Lieu de la reunion"}, {"type": "text", "key": "Noms_des_redacteurs", "label": "Noms des redacteurs"}, {"type": "text", "key": "Clubs_des_redacteurs", "label": "Clubs des redacteurs"}, {"type": "text", "key": "Statuts_des_redacteurs", "label": "Statuts des redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}]}, {"type": "table", "key": "tableau_de_presence", "label": "Tableau de presence", "columns": [{"key": "statut_des_adherents", "label": "Statut des adherents"}, {"key": "prenom_et_nom", "label": "Prenom et nom"}, {"key": "presence", "label": "Presence"}, {"key": "droit_de_vote", "label": "Droit de vote"}], "presetRows": [{"statut": "Membre"}, {"statut": "Nouveau membre"}, {"statut": "Senior"}, {"statut": "Responsable"}], "note": "Mentionner la presence ou absence, retard, le droit de vote et les personnes presentes et censees etre presentes."}, {"type": "section", "key": "II_Le_Proces_Verbal", "label": "Le Proces Verbal", "children": [{"type": "text", "key": "presidents_de_la_reunion", "label": "Presidents de la reunion"}, {"type": "text", "key": "heure_de_debut", "label": "Heure de debut"}, {"type": "text", "key": "heure_de_fin", "label": "Heure de fin"}, {"type": "table", "key": "points_ordre_du_jour", "label": "Points ordre du jour", "columns": [{"key": "point_ordre_du_jour_et_duree_estimee", "label": "Point ordre du jour et duree estimee"}, {"key": "discussions", "label": "Discussions"}, {"key": "conclusion", "label": "Conclusion"}, {"key": "conduites_a_tenir_et_echeances", "label": "Conduites a tenir et echeances"}, {"key": "documents", "label": "Documents"}, {"key": "duree_reelle_du_point", "label": "Duree reelle du point"}], "presetRows": [{"point": "Adoption du proces verbal precedent"}]}, {"type": "text", "key": "photos_captures_ecran", "label": "Photos captures ecran"}]}], "titleTemplate": "Proces-verbal de X eme reunion de X entite"}$tpl$::jsonb),

  ('investigation_officiel', 'Rapport d''investigation', 'investigation',
   'Dossier d''investigation disciplinaire du SupCo : saisine, faits, auditions, constats et décision (Annexe I.1.19 / RI).',
   'SupCo National (local) / CSCY (national)', '5 jours avant l''AL concernée (local) / 10 jours avant l''AG concernée (national)', -5,
   '["titre", "I_Contextualisation", "II_Sommaire"]'::jsonb, '["supervision"]'::jsonb,
   'supco_local', 'local', false, '["SupCo Local", "SupCo National"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_des_redacteurs", "label": "Nom des redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_generale_locale_visee", "label": "Assemblee generale locale visee"}]}, {"type": "section", "key": "II_Sommaire", "label": "Sommaire", "children": [{"type": "section", "key": "sujet_de_l_investigation", "label": "Sujet de l investigation", "children": [{"type": "text", "key": "reception_par_e_mail", "label": "Reception par e mail"}, {"type": "text", "key": "detection_par_conseil_de_supervision", "label": "Detection par conseil de supervision"}, {"type": "text", "key": "points_du_reglement_non_respectes", "label": "Points du reglement non respectes"}]}, {"type": "text", "key": "cadre_de_l_investigation", "label": "Cadre de l investigation"}, {"type": "section", "key": "parties_prenantes", "label": "Parties prenantes", "children": [{"type": "repeatable_text", "key": "accuses", "label": "Accuses"}, {"type": "repeatable_text", "key": "plaignants", "label": "Plaignants"}, {"type": "repeatable_text", "key": "temoins", "label": "Temoins"}, {"type": "repeatable_text", "key": "experts", "label": "Experts"}]}, {"type": "text", "key": "questions_visees", "label": "Questions visees"}, {"type": "text", "key": "differentes_versions_reponses", "label": "Differentes versions reponses"}, {"type": "text", "key": "analyse_de_la_situation", "label": "Analyse de la situation"}, {"type": "text", "key": "solution", "label": "Solution"}, {"type": "text", "key": "recommandation", "label": "Recommandation"}, {"type": "text", "key": "honnetete_transparence_du_conseil", "label": "Honnetete transparence du conseil"}]}, {"type": "text", "key": "III_Le_rapport", "label": "Le rapport"}], "titleTemplate": "Titre de l'investigation"}$tpl$::jsonb),

  ('supervision_officiel', 'Rapport de supervision', 'supervision',
   'Suivi de supervision par phase (instruction, prise de fonction, passation, encadrement) et par personne supervisée.',
   'SupCo National (local) / CSCY (national)', '5 jours avant l''AL concernée (local) / 10 jours avant l''AG concernée (national)', -5,
   '["I_Contextualisation", "I_Le_rapport"]'::jsonb, '["supervision"]'::jsonb,
   'supco_local', 'local', false, '["SupCo Local", "SupCo National"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_des_redacteurs", "label": "Nom des redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_generale_locale_visee", "label": "Assemblee generale locale visee"}]}, {"type": "table", "key": "I_Le_rapport", "label": "Le rapport", "columns": [{"key": "prenom_et_nom_du_superviseur", "label": "Prenom et nom du superviseur"}, {"key": "departement", "label": "Departement"}, {"key": "prenom_et_nom_de_la_personne_supervisee", "label": "Prenom et nom de la personne supervisee"}, {"key": "phase_en_cours", "label": "Phase en cours"}, {"key": "objectifs_de_la_phase_en_cours", "label": "Objectifs de la phase en cours"}, {"key": "mise_a_jour_des_objectifs", "label": "Mise a jour des objectifs"}, {"key": "attitudes_des_membres_bdn_bdl", "label": "Attitudes des membres bdn bdl"}], "presetRows": [], "extra": {"phase_en_cours_options": {"type": "list", "key": "phase_en_cours_options", "label": "Phase en cours options", "options": ["Instruction", "Prise de fonction", "Passation", "Encadrement"]}, "attitudes_options": {"type": "list", "key": "attitudes_options", "label": "Attitudes options", "options": ["Implication", "Motivation", "Integration", "Soutien", "Reconnaissance", "Fidelisation", "Instruction"]}}}]}$tpl$::jsonb),

  ('recommandation_parrains_officiel', 'Rapport de Recommandation des Parrains', 'recommandation_parrains',
   'Recommandation détaillée de chaque parrain sur les nouveaux membres, soumise à l''adoption en ALOV (RI I.7.7.3-4).',
   'CSCY Local', '5 jours avant l''ALOV', -5,
   '["I_Contextualisation", "II_Sommaire", "III_Le_Rapport"]'::jsonb, '["coordination_strategique"]'::jsonb,
   'vpi', 'local', false, '["Parrains des nouveaux membres du club (VPI)"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_des_redacteurs", "label": "Nom des redacteurs"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_Locale_visee", "label": "Assemblee Locale visee"}]}, {"type": "section", "key": "II_Sommaire", "label": "Sommaire", "children": [{"type": "text", "key": "1_procedure_de_validation", "label": "Procedure de validation"}, {"type": "text", "key": "2_criteres_de_validation", "label": "Criteres de validation"}, {"type": "section", "key": "3_parrain_1", "label": "Parrain 1", "children": [{"type": "text", "key": "nouveaux_membres_valides", "label": "Nouveaux membres valides"}, {"type": "text", "key": "raisons_de_refus", "label": "Raisons de refus"}]}, {"type": "section", "key": "4_parrain_n", "label": "Parrain n", "children": [{"type": "text", "key": "nouveaux_membres_valides", "label": "Nouveaux membres valides"}, {"type": "text", "key": "raisons_de_refus", "label": "Raisons de refus"}]}, {"type": "text", "key": "5_autres_remarques", "label": "Autres remarques"}]}, {"type": "section", "key": "III_Le_Rapport", "label": "Le Rapport", "children": [{"type": "text", "key": "introduction", "label": "Introduction"}, {"type": "text", "key": "1_procedure_de_validation", "label": "Procedure de validation"}, {"type": "text", "key": "2_criteres_de_validation", "label": "Criteres de validation"}, {"type": "table", "key": "3_parrain_1", "label": "Parrain 1", "columns": [{"key": "nouveau_membre", "label": "Nouveau membre"}, {"key": "decision", "label": "Decision"}, {"key": "raison", "label": "Raison"}], "presetRows": []}, {"type": "table", "key": "4_parrain_n", "label": "Parrain n", "columns": [{"key": "nouveau_membre", "label": "Nouveau membre"}, {"key": "decision", "label": "Decision"}, {"key": "raison", "label": "Raison"}], "presetRows": []}, {"type": "text", "key": "5_autres_remarques", "label": "Autres remarques"}]}]}$tpl$::jsonb),

  ('recommandation_vpa', 'Rapport de recommandation du VPA', 'recommandation_vpa',
   'Recrutement et validation des nouveaux clubs et des nouveaux membres nationaux (national uniquement).',
   'CSCY', '10 jours avant le début de la première plénière de chaque AG', -10,
   '["I_Contextualisation", "I_Sommaire"]'::jsonb, '["coordination_strategique"]'::jsonb,
   null, 'national', false, '["VPA"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Mandat", "label": "Mandat"}, {"type": "text", "key": "Nom_de_redacteur", "label": "Nom de redacteur"}, {"type": "text", "key": "Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "Date_d_envoi", "label": "Date d envoi"}, {"type": "text", "key": "Assemblee_generale_visee", "label": "Assemblee generale visee"}]}, {"type": "section", "key": "I_Sommaire", "label": "Sommaire", "children": [{"type": "section", "key": "1_Recrutement_nouveaux_clubs", "label": "Recrutement nouveaux clubs", "children": [{"type": "text", "key": "a_procedure_de_recrutement", "label": "Procedure de recrutement"}, {"type": "text", "key": "b_criteres_de_selection", "label": "Criteres de selection"}, {"type": "text", "key": "c_clubs_postulants", "label": "Clubs postulants"}, {"type": "text", "key": "d_clubs_retenus", "label": "Clubs retenus"}, {"type": "text", "key": "e_raisons_de_refus", "label": "Raisons de refus"}, {"type": "text", "key": "f_noms_et_abreviations", "label": "Noms et abreviations"}]}, {"type": "section", "key": "2_Validation_nouveaux_clubs", "label": "Validation nouveaux clubs", "children": [{"type": "text", "key": "a_procedure_de_validation", "label": "Procedure de validation"}, {"type": "text", "key": "b_criteres_de_validation", "label": "Criteres de validation"}, {"type": "text", "key": "c_clubs_retenus", "label": "Clubs retenus"}, {"type": "text", "key": "d_raisons_de_refus", "label": "Raisons de refus"}]}, {"type": "section", "key": "3_Recrutement_membres_nationaux", "label": "Recrutement membres nationaux", "children": [{"type": "text", "key": "a_procedure_de_recrutement", "label": "Procedure de recrutement"}, {"type": "text", "key": "b_criteres_d_acceptation", "label": "Criteres d acceptation"}, {"type": "text", "key": "c_demandes_recues", "label": "Demandes recues"}, {"type": "text", "key": "d_demandes_retenues", "label": "Demandes retenues"}, {"type": "text", "key": "e_raisons_de_refus", "label": "Raisons de refus"}]}, {"type": "text", "key": "4_Autres_remarques", "label": "Autres remarques"}]}, {"type": "section", "key": "II_Le_Rapport", "label": "Le Rapport", "children": [{"type": "text", "key": "introduction", "label": "Introduction"}, {"type": "section", "key": "1_recrutement_nouveaux_clubs", "label": "Recrutement nouveaux clubs", "children": [{"type": "section", "key": "a_procedure_de_recrutement", "label": "Procedure de recrutement", "children": [{"type": "list", "key": "etapes", "label": "Etapes", "options": ["Formulaire mis a disposition des externes voulant fonder des YOUTH CLUBs", "Le VPA organise une ou deux reunions explicatives", "Le VPA invite l'equipe fondatrice a un entretien", "Les membres de l'equipe fondatrice remplissent le formulaire des adherents", "Lancement des formations des nouveaux membres et responsables locaux", "Communication du rapport de recommandation aux adherents", "Une fois valide par l'AG, organisation de l'ALC", "Paiement de la cotisation nationale pour valider l'adhesion"]}, {"type": "text", "key": "lien_formulaire", "label": "Lien formulaire"}]}, {"type": "text", "key": "b_criteres_de_selection", "label": "Criteres de selection"}, {"type": "table", "key": "c_clubs_postulants", "label": "Clubs postulants", "columns": [{"key": "zone", "label": "Zone"}, {"key": "etablissement", "label": "Etablissement"}], "presetRows": []}, {"type": "table", "key": "d_raisons_de_refus", "label": "Raisons de refus", "columns": [{"key": "zone", "label": "Zone"}, {"key": "etablissement", "label": "Etablissement"}, {"key": "raisons", "label": "Raisons"}], "presetRows": []}, {"type": "table", "key": "e_clubs_retenus", "label": "Clubs retenus", "columns": [{"key": "zone", "label": "Zone"}, {"key": "etablissement", "label": "Etablissement"}, {"key": "etape_de_recrutement", "label": "Etape de recrutement"}, {"key": "notation_selon_criteres", "label": "Notation selon criteres"}], "presetRows": []}, {"type": "table", "key": "f_noms_et_abreviations_retenus", "label": "Noms et abreviations retenus", "columns": [{"key": "zone", "label": "Zone"}, {"key": "nom_de_l_etablissement", "label": "Nom de l etablissement"}, {"key": "nom_officiel_du_club", "label": "Nom officiel du club"}, {"key": "abreviation", "label": "Abreviation"}], "presetRows": []}]}, {"type": "section", "key": "2_validation_nouveaux_clubs", "label": "Validation nouveaux clubs", "children": [{"type": "text", "key": "a_procedure_de_validation", "label": "Procedure de validation"}, {"type": "text", "key": "b_criteres_de_validation", "label": "Criteres de validation"}, {"type": "table", "key": "c_clubs_valides", "label": "Clubs valides", "columns": [{"key": "nom_du_club", "label": "Nom du club"}, {"key": "zone", "label": "Zone"}], "presetRows": []}, {"type": "table", "key": "d_raisons_de_refus", "label": "Raisons de refus", "columns": [{"key": "zone", "label": "Zone"}, {"key": "etablissement", "label": "Etablissement"}, {"key": "raisons", "label": "Raisons"}], "presetRows": []}]}, {"type": "section", "key": "3_recrutement_membres_nationaux", "label": "Recrutement membres nationaux", "children": [{"type": "text", "key": "a_procedure_de_recrutement", "label": "Procedure de recrutement"}, {"type": "text", "key": "b_criteres_d_acceptation", "label": "Criteres d acceptation"}, {"type": "text", "key": "c_demandes_recues", "label": "Demandes recues"}, {"type": "text", "key": "d_demandes_retenues", "label": "Demandes retenues"}, {"type": "text", "key": "e_raisons_de_refus", "label": "Raisons de refus"}]}, {"type": "text", "key": "4_autres_remarques", "label": "Autres remarques"}]}]}$tpl$::jsonb),

  ('amendements', 'Formulaire des amendements', 'amendement',
   'Proposition de modification d''un point ou sous-point du règlement, soumise au vote de l''AG (national uniquement).',
   'CSCY National', 'Ouvert 10 jours avant l''AG et fermé à sa clôture', null,
   '["les_proposants", "point_ou_sous_point_a_amender_version_initiale", "proposition_d_amendement"]'::jsonb, '["cscy"]'::jsonb,
   null, 'national', true, '["Toute entité proposante (SupCo National, BEN, CNS, membres nationaux, clubs)"]'::jsonb,
   $tpl${"sections": [{"type": "text", "key": "email", "label": "Email"}, {"type": "select", "key": "les_proposants", "label": "Les proposants", "options": ["SUPCO national", "BEN", "CNS", "L'ensemble des membres nationaux", "Nom du club (liste des clubs)", "Other"]}, {"type": "text", "key": "point_ou_sous_point_a_amender_version_initiale", "label": "Point ou sous point a amender version initiale"}, {"type": "text", "key": "proposition_d_amendement", "label": "Proposition d amendement"}, {"type": "text", "key": "raison_pour_laquelle_ce_point_doit_etre_amende", "label": "Raison pour laquelle ce point doit etre amende"}], "description": "Un amendement est une proposition de modification, soumise au vote d'une assemblee, en vue de corriger, completer ou annuler un point ou sous-point du document de la reglementation."}$tpl$::jsonb),

  ('motions_procedurales', 'Formulaire de proposition des motions procédurales', 'motion_procedurale',
   'Proposition d''une motion procédurale soumise à une assemblée délibérante (national uniquement).',
   'CSCY National', 'Ouvert 10 jours avant l''AG et fermé à sa clôture', null,
   '["types_de_motions_procedurales"]'::jsonb, '["cscy"]'::jsonb,
   null, 'national', true, '["Toute entité proposante"]'::jsonb,
   $tpl${"sections": [{"type": "list", "key": "types_de_motions_procedurales", "label": "Types de motions procedurales", "options": ["Le changement de l'agenda", "Le report de l'Assemblee Generale", "Le changement de la methode de vote", "Le report de la motion actuelle", "La reouverture d'une motion", "La reouverture de la liste des orateurs", "La suspension d'un point ou d'un sous-point du reglement jusqu'a la fin de l'AG ou jusqu'a ce qu'il soit repris par l'AG", "La reprise d'un point ou d'un sous-point du reglement qui a ete suspendu", "Le depassement de la decision du President de session de l'AG", "Le vote de censure pour destituer le President de session de l'AG", "Le depassement d'une interpretation du CSCY et la proposition d'une interpretation alternative", "Les observateurs doivent quitter la salle"]}, {"type": "text", "key": "note", "label": "Note", "placeholder": "Le formulaire doit etre rempli par le mail officiel du club au responsable (X youth club, VPR association, Supco association...)"}, {"type": "text", "key": "email", "label": "Email"}, {"type": "select", "key": "les_proposants", "label": "Les proposants", "options": ["SUPCO national", "BEN", "CNS", "L'ensemble des membres nationaux", "Nom du club (liste des clubs)", "Other"]}, {"type": "text", "key": "motion_procedurale", "label": "Motion procedurale"}, {"type": "text", "key": "description_si_necessaire", "label": "Description si necessaire"}], "description": "Une motion est une proposition soumise a une assemblee deliberante par un ou plusieurs de ses participants qui ont le droit de proposition, afin de presenter ou faire prendre une decision."}$tpl$::jsonb),

  ('pv_assemblee', 'Procès-verbal d''assemblée (AG ou AL)', 'pv_assemblee',
   'Procès-verbal complet d''une assemblée générale ou locale, plénière par plénière (national/EPN-EPL uniquement).',
   'CSCY National (AG) / Secrétaire de l''AG (AL)', '2 mois après la fin de l''AG / 5 jours après l''AL', null,
   '["titre", "I_Contextualisation", "II_Plenieres"]'::jsonb, '["secretariat", "cscy"]'::jsonb,
   null, 'national', false, '["Secrétaires de session (EPN/EPL)"]'::jsonb,
   $tpl${"sections": [{"type": "section", "key": "I_Contextualisation", "label": "Contextualisation", "children": [{"type": "text", "key": "Etat", "label": "Etat", "placeholder": "Adopte / Soumis a l'adoption / Non adopte"}, {"type": "text", "key": "Type_de_l_assemblee", "label": "Type de l assemblee", "placeholder": "assemblee locale ou generale"}, {"type": "text", "key": "Date_de_debut", "label": "Date de debut"}, {"type": "text", "key": "Date_de_fin", "label": "Date de fin"}, {"type": "text", "key": "Lieu", "label": "Lieu"}, {"type": "text", "key": "Noms_des_redacteurs", "label": "Noms des redacteurs"}, {"type": "text", "key": "Clubs_postes_des_redacteurs", "label": "Clubs postes des redacteurs"}, {"type": "text", "key": "Organisateurs_de_l_assemblee", "label": "Organisateurs de l assemblee"}]}, {"type": "section", "key": "II_Plenieres", "label": "Plenieres", "children": [{"type": "repeatable_group", "key": "plenieres", "label": "Plenieres", "itemFields": [{"type": "text", "key": "date_de_la_pleniere", "label": "Date de la pleniere"}, {"type": "text", "key": "lieu_de_la_pleniere", "label": "Lieu de la pleniere"}, {"type": "text", "key": "heure_de_debut", "label": "Heure de debut"}, {"type": "text", "key": "heure_de_cloture", "label": "Heure de cloture"}, {"type": "section", "key": "equipe_pleniere", "label": "Equipe pleniere", "children": [{"type": "text", "key": "president", "label": "President"}, {"type": "text", "key": "vice_president", "label": "Vice president"}, {"type": "repeatable_text", "key": "secretaires", "label": "Secretaires"}, {"type": "repeatable_text", "key": "cscy", "label": "Cscy"}, {"type": "repeatable_text", "key": "comite_financier", "label": "Comite financier"}]}, {"type": "repeatable_text", "key": "agenda_de_la_pleniere", "label": "Agenda de la pleniere"}, {"type": "table", "key": "liste_de_presence_clubs_membres", "label": "Liste de presence clubs membres", "columns": [{"key": "nom_du_club", "label": "Nom du club"}, {"key": "representant_du_club", "label": "Representant du club"}, {"key": "statut", "label": "Statut"}, {"key": "present", "label": "Present"}, {"key": "absent", "label": "Absent"}, {"key": "droit_de_vote", "label": "Droit de vote"}], "presetRows": []}, {"type": "table", "key": "liste_de_presence_ben_bel_supco", "label": "Liste de presence ben bel supco", "columns": [{"key": "poste", "label": "Poste"}, {"key": "prenom_et_nom", "label": "Prenom et nom"}, {"key": "present", "label": "Present"}, {"key": "absent", "label": "Absent"}], "presetRows": []}, {"type": "table", "key": "liste_des_invites", "label": "Liste des invites", "columns": [{"key": "nom_de_l_organisation", "label": "Nom de l organisation"}, {"key": "prenom_et_nom", "label": "Prenom et nom"}, {"key": "present", "label": "Present"}, {"key": "absent", "label": "Absent"}], "presetRows": []}, {"type": "repeatable_group", "key": "motions", "label": "Motions", "itemFields": [{"type": "text", "key": "heure_de_debut", "label": "Heure de debut"}, {"type": "text", "key": "nom_de_la_motion", "label": "Nom de la motion"}, {"type": "text", "key": "proposant", "label": "Proposant"}, {"type": "text", "key": "secondant", "label": "Secondant"}, {"type": "text", "key": "amendement", "label": "Amendement"}, {"type": "text", "key": "direct_negatif", "label": "Direct negatif"}, {"type": "text", "key": "majorite_utilisee", "label": "Majorite utilisee", "placeholder": "Simple / Absolue / Relative / 2/3"}, {"type": "text", "key": "resultat", "label": "Resultat"}, {"type": "text", "key": "consequence", "label": "Consequence"}, {"type": "text", "key": "discussion", "label": "Discussion"}, {"type": "text", "key": "heure_de_cloture", "label": "Heure de cloture"}, {"type": "text", "key": "duree", "label": "Duree"}, {"type": "section", "key": "notes", "label": "Notes", "children": [{"type": "text", "key": "entrees_sorties_participants", "label": "Entrees sorties participants"}, {"type": "text", "key": "changements_equipe_pleniere", "label": "Changements equipe pleniere"}, {"type": "text", "key": "points_d_information", "label": "Points d information"}, {"type": "text", "key": "points_d_ordre", "label": "Points d ordre"}]}], "presetRows": [{"heure_de_debut": "", "nom_de_la_motion": "", "proposant": "", "secondant": "", "amendement": false, "direct_negatif": false, "majorite_utilisee": "Simple / Absolue / Relative / 2/3", "resultat": "", "consequence": "", "discussion": "", "heure_de_cloture": "", "duree": "", "notes": {"entrees_sorties_participants": "", "changements_equipe_pleniere": "", "points_d_information": "", "points_d_ordre": ""}}]}], "presetRows": [{"date_de_la_pleniere": "", "lieu_de_la_pleniere": "", "heure_de_debut": "", "heure_de_cloture": "", "equipe_pleniere": {"president": "", "vice_president": "", "secretaires": [], "cscy": [], "comite_financier": []}, "agenda_de_la_pleniere": [], "liste_de_presence_clubs_membres": {"colonnes": ["nom_du_club", "representant_du_club", "statut", "present", "absent", "droit_de_vote"], "lignes": []}, "liste_de_presence_ben_bel_supco": {"colonnes": ["poste", "prenom_et_nom", "present", "absent"], "lignes": []}, "liste_des_invites": {"colonnes": ["nom_de_l_organisation", "prenom_et_nom", "present", "absent"], "lignes": []}, "motions": [{"heure_de_debut": "", "nom_de_la_motion": "", "proposant": "", "secondant": "", "amendement": false, "direct_negatif": false, "majorite_utilisee": "Simple / Absolue / Relative / 2/3", "resultat": "", "consequence": "", "discussion": "", "heure_de_cloture": "", "duree": "", "notes": {"entrees_sorties_participants": "", "changements_equipe_pleniere": "", "points_d_information": "", "points_d_ordre": ""}}]}]}], "note": "Repeter cette partie pour chaque pleniere"}], "titleTemplate": "Proces-verbal de X eme assemblee de X type de X mois"}$tpl$::jsonb),

  ('cscy_final_national', 'Rapport final du CSCY National', 'cscy_final',
   'Rapport de clôture d''une AG, présenté et adopté pendant la dernière plénière (national uniquement).',
   'Présenté et adopté pendant la dernière plénière de l''AG', 'Avant son adoption', null,
   '["I_Mandat", "V_Introduction", "VI_Sommaire", "VIII_Les_decisions_prises_par_l_AG", "XIII_Recommandations"]'::jsonb, '["cscy"]'::jsonb,
   null, 'national', false, '["Membres du CSCY National"]'::jsonb,
   $tpl${"sections": [{"type": "text", "key": "I_Mandat", "label": "Mandat"}, {"type": "text", "key": "II_Nom_des_redacteurs", "label": "Nom des redacteurs"}, {"type": "text", "key": "III_Date_de_redaction", "label": "Date de redaction"}, {"type": "text", "key": "IV_L_assemblee_generale_visee", "label": "L assemblee generale visee"}, {"type": "text", "key": "V_Introduction", "label": "Introduction"}, {"type": "text", "key": "VI_Sommaire", "label": "Sommaire"}, {"type": "text", "key": "VII_Droit_de_vote", "label": "Droit de vote"}, {"type": "section", "key": "VIII_Les_decisions_prises_par_l_AG", "label": "Les decisions prises par l AG", "children": [{"type": "text", "key": "A_Resultat_de_vote_sur_les_candidatures", "label": "A Resultat de vote sur les candidatures"}, {"type": "text", "key": "B_Decision_prise_au_sujet_des_rapports_presentes", "label": "B Decision prise au sujet des rapports presentes"}, {"type": "text", "key": "C_les_autres_decisions_de_l_AG", "label": "Les autres decisions de l AG"}]}, {"type": "text", "key": "IX_Statut_des_clubs", "label": "Statut des clubs"}, {"type": "text", "key": "X_Interpretations", "label": "Interpretations"}, {"type": "text", "key": "XI_les_motions_procedurales", "label": "Les motions procedurales"}, {"type": "text", "key": "XII_les_failles_du_document_de_la_reglementation", "label": "Les failles du document de la reglementation"}, {"type": "text", "key": "XIII_Recommandations", "label": "Recommandations"}]}$tpl$::jsonb)
on conflict (slug) do update set
  schema_json = excluded.schema_json,
  utilise_par = excluded.utilise_par,
  is_form = excluded.is_form,
  required_sections = excluded.required_sections,
  description = excluded.description,
  recipient = excluded.recipient,
  deadline_rule = excluded.deadline_rule;

