-- HISTORICAL — superseded by live sync, do not re-run on an existing DB.
--
-- portal_schools is no longer a one-time snapshot: api/_lib/store.js
-- calls api/_lib/schools-sync.js on every saveClub / deleteClub, so the
-- table now stays automatically in sync with data/clubs/*.json (schools
-- appear when a club goes "live", deactivate when it doesn't, and are
-- deactivated + have their members hard-deleted when the club is
-- deleted outright). See schools-sync.js for the exact rules.
--
-- This file is kept only as the original bootstrap for a brand-new
-- database, in case you need one row to test against before the first
-- real saveClub call happens. Everything below is redundant once the
-- app has been live for even one club save/delete cycle.

insert into portal_schools (slug, name) values
  ('labc',   'Lycée Belgesm'),
  ('lph',    'Lycée Elhay'),
  ('lpse',   'Lycée Pilote Sekiet Ezzit')
on conflict (slug) do nothing;
