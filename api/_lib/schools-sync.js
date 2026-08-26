// schools-sync.js
//
// Keeps portal_schools (Neon) in sync with data/clubs/*.json (GitHub)
// automatically, every time a club is saved or deleted by the Discord
// bot. This replaces the old one-time db/seed-schools.sql snapshot —
// that file is now historical only; don't re-run it.
//
// Rules (deliberately simple, per product decision — no draft/test clubs
// are expected to ever exist in data/clubs, so no extra guarding beyond
// the existing "status" field is needed):
//
//   - club.status === "live"  -> portal_schools row exists & is_active = true,
//                                 name kept in sync with club.name.
//   - club.status !== "live"  -> portal_schools row (if any) is deactivated
//                                 (is_active = false). Members are NOT
//                                 touched in this case (a club going back
//                                 to draft is not the same as deletion).
//   - club deleted entirely   -> portal_schools row deactivated AND every
//                                 portal_members row on that school is
//                                 hard-deleted (their accounts no longer
//                                 have anywhere to belong).
//
// This module is intentionally the ONLY place that writes to
// portal_schools from the club-sites side. If store.js's saveClub /
// deleteClub ever gain new call sites, they get this sync for free —
// nothing else needs to remember to call it.

const { sql } = require("./db");

// Called from store.saveClub(club, ...) with the club object that was
// just written to GitHub. Safe to call even if DATABASE_URL isn't set
// yet (e.g. local dev on the bot side without the portal configured) —
// failures here are logged, not thrown, so a Discord bot action never
// fails because of the portal's database.
async function syncSchoolOnSave(club) {
  if (!process.env.DATABASE_URL) return; // portal not configured — no-op
  if (!club || !club.slug) return;

  try {
    const db = sql();
    if (club.status === "live") {
      await db`
        insert into portal_schools (slug, name, is_active)
        values (${club.slug}, ${club.name || club.slug}, true)
        on conflict (slug) do update
          set name = excluded.name,
              is_active = true
      `;
    } else {
      // Went back to draft / archived without being deleted outright —
      // hide it as a signup option but leave existing members alone.
      await db`
        update portal_schools set is_active = false where slug = ${club.slug}
      `;
    }
  } catch (err) {
    console.error(`schools-sync: failed to sync club "${club.slug}" on save:`, err);
  }
}

// Called from store.deleteClub(slug, ...) AFTER the GitHub file is
// deleted. Deactivates the school and hard-deletes every member whose
// school_id points at it, per product decision: an account has no
// standing once its club no longer exists.
async function syncSchoolOnDelete(slug) {
  if (!process.env.DATABASE_URL) return;
  if (!slug) return;

  try {
    const db = sql();
    const schools = await db`select id from portal_schools where slug = ${slug}`;
    const school = schools[0];
    if (!school) return; // never existed in the portal — nothing to do

    const deletedMembers = await db`
      delete from portal_members where school_id = ${school.id}
      returning id
    `;
    await db`update portal_schools set is_active = false where id = ${school.id}`;

    if (deletedMembers.length) {
      console.log(
        `schools-sync: club "${slug}" deleted — removed ${deletedMembers.length} portal member(s) that belonged to it.`
      );
    }
  } catch (err) {
    console.error(`schools-sync: failed to sync club "${slug}" on delete:`, err);
  }
}

module.exports = { syncSchoolOnSave, syncSchoolOnDelete };
