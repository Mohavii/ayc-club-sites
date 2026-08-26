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

  -- Coarse admin flag for this first phase. The full per-club,
  -- per-capability role system (Président / Secrétaire / report
  -- validators / membership approvers per club) is a separate, later
  -- phase — out of scope for this build. National admins are the only
  -- role this phase knows about, and they gate membership validation.
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
