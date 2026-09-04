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

