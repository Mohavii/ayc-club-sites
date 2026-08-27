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
  category text not null check (category in ('received','delivered','facilitation','other')),
  title text not null,
  host text,
  held_on date,
  location text,
  booklet_url text,
  hours numeric(8,2),
  notes text,
  evidence_document_id uuid references portal_member_documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_training_member on portal_training_entries(member_id, held_on desc);

alter table portal_training_entries add column if not exists evidence_document_id uuid references portal_member_documents(id) on delete set null;
alter table portal_training_entries add column if not exists updated_at timestamptz not null default now();

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
  ('mise_a_jour', 'Rapport de mise à jour', 'mise_a_jour', 'Mise à jour périodique de la vie du club.', 'Bureau exécutif national', 'Selon le calendrier annuel', 0, '["activite", "membres", "responsabilites", "projets", "besoins"]'::jsonb, '["coordination_strategique", "secretariat"]'::jsonb),
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
  assembly_type text not null check (assembly_type in ('alofm','adhesion','validation','aloe','dissolution','ag_ordinaire','ag_extraordinaire')),
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
