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
                'meeting_organizer'
              )),
  granted_by  uuid references portal_members(id),
  granted_at  timestamptz not null default now(),
  revoked_at   text, -- null = currently active

  -- Deliberately NO uniqueness constraint on (member_id, school_id,
  -- capability) beyond what the app enforces on insert — a member can
  -- only usefully hold a given capability once at a time per club, but
  -- unlike display roles there's no hard exclusivity BETWEEN different
  -- capabilities, so a single exclude constraint doesn't apply here.
);

create index if not exists idx_capability_grants_member on portal_capability_grants(member_id);
create index if not exists idx_capability_grants_lookup
  on portal_capability_grants(school_id, capability) where revoked_at is null;

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
  school_id integer not null references portal_schools(id) on delete cascade,
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

create table if not exists portal_meetings (
  id uuid primary key default gen_random_uuid(),
  school_id integer not null references portal_schools(id) on delete cascade,
  created_by uuid not null references portal_members(id),
  title text not null,
  meeting_type text not null check (meeting_type in ('reunion','assemblee_locale','assemblee_generale')),
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

create table if not exists portal_training_entries (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  category text not null check (category in ('received','delivered','facilitation','other')),
  title text not null,
  host text,
  held_on date,
  location text,
  booklet_url text,
  hours numeric(8,2),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_training_member on portal_training_entries(member_id, held_on desc);

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
  created_by uuid not null references portal_members(id),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_tasks_assignee on portal_tasks(assigned_to, deadline);

create table if not exists portal_responsibilities (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references portal_members(id) on delete cascade,
  school_id integer references portal_schools(id) on delete cascade,
  title text not null,
  description text,
  project_url text,
  database_url text,
  held_on date,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_responsibilities_member on portal_responsibilities(member_id, held_on desc);
