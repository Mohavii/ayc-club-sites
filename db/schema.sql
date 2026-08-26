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

-- The exclude constraint above needs the btree_gist extension (gist
-- indexes don't support plain `=` on uuid/integer without it).
create extension if not exists btree_gist;

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
  revoked_at  timestamptz -- null = currently active

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
