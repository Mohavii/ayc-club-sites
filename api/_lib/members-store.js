// members-store.js
//
// All reads/writes for portal_members and portal_schools. This is a
// brand-new data model for a brand-new system — it does NOT read from or
// write to data/clubs/*.json, and a member here has no relationship to a
// Discord user ID, a club's `officers` array, or a `vpcRoleId`. See
// api/_lib/permissions.js (the Discord bot's role check) for contrast —
// nothing in this file calls it or is called by it.

const { sql } = require("./db");

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

function validateUsername(username) {
  if (typeof username !== "string") return "Nom d'utilisateur requis.";
  if (!USERNAME_RE.test(username)) {
    return "Le nom d'utilisateur doit contenir 3 à 24 caractères : lettres minuscules, chiffres, underscore.";
  }
  return null;
}

async function findMemberByGoogleId(googleId) {
  const db = sql();
  const rows = await db`select * from portal_members where google_id = ${googleId}`;
  return rows[0] || null;
}

async function findMemberByUsername(username) {
  const db = sql();
  const rows = await db`select * from portal_members where username = ${username}`;
  return rows[0] || null;
}

async function findMemberById(id) {
  const db = sql();
  const rows = await db`select * from portal_members where id = ${id}`;
  return rows[0] || null;
}

async function listSchools() {
  const db = sql();
  return db`select id, slug, name from portal_schools where is_active = true order by name asc`;
}

function isBootstrapAdminEmail(email) {
  const list = (process.env.PORTAL_BOOTSTRAP_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(email.toLowerCase());
}

// Creates the member record from a completed onboarding form. If the
// email matches PORTAL_BOOTSTRAP_ADMIN_EMAILS, the account is activated
// immediately and flagged as a national admin — this is the one
// chicken-and-egg exception (someone has to be the first admin able to
// approve anyone else) and is a deliberate, documented bootstrap path,
// not a general bypass.
async function createMemberFromOnboarding({ googleId, email, username, displayName, profilePictureUrl, schoolId }) {
  const db = sql();
  const bootstrap = isBootstrapAdminEmail(email);
  const status = bootstrap ? "active" : "pending";
  const rows = await db`
    insert into portal_members
      (google_id, email, username, display_name, profile_picture_url, school_id, status, is_national_admin, decided_at)
    values
      (${googleId}, ${email}, ${username}, ${displayName}, ${profilePictureUrl || null}, ${schoolId},
       ${status}, ${bootstrap}, case when ${bootstrap} then now() else null end)
    returning *
  `;
  return rows[0];
}

async function listPendingMembers() {
  const db = sql();
  return db`
    select m.*, s.name as school_name
    from portal_members m
    left join portal_schools s on s.id = m.school_id
    where m.status = 'pending'
    order by m.created_at asc
  `;
}

async function decideMembership({ memberId, decision, decidedBy, rejectionNote }) {
  const db = sql();
  const status = decision === "approve" ? "active" : "rejected";
  const rows = await db`
    update portal_members
    set status = ${status},
        decided_at = now(),
        decided_by = ${decidedBy},
        rejection_note = ${status === "rejected" ? rejectionNote || null : null}
    where id = ${memberId} and status = 'pending'
    returning *
  `;
  return rows[0] || null;
}

async function setNationalAdmin(memberId, isAdmin) {
  const db = sql();
  const rows = await db`
    update portal_members
    set is_national_admin = ${isAdmin}
    where id = ${memberId}
    returning *
  `;
  return rows[0] || null;
}

async function listNationalAdminEmails() {
  const db = sql();
  const rows = await db`
    select email from portal_members where is_national_admin = true and status = 'active'
  `;
  return rows.map((r) => r.email);
}

async function listActiveMembersBySchool(schoolId) {
  const db = sql();
  return db`
    select id, username, display_name, profile_picture_url, email
    from portal_members
    where school_id = ${schoolId} and status = 'active'
    order by display_name asc
  `;
}

// Free-text search across all active members regardless of club — used
// by the admin "Équipe Plénière Nationale" tab to find someone to seat
// on a national role, since national roles aren't scoped to a club and
// so can't be reached through the club-first browse flow.
async function searchActiveMembers(query) {
  const db = sql();
  const like = `%${String(query || "").trim().toLowerCase()}%`;
  if (!like || like === "%%") return [];
  return db`
    select id, username, display_name, profile_picture_url, email
    from portal_members
    where status = 'active'
      and (lower(username) like ${like} or lower(display_name) like ${like})
    order by display_name asc
    limit 20
  `;
}

module.exports = {
  validateUsername,
  findMemberByGoogleId,
  findMemberByUsername,
  findMemberById,
  listSchools,
  listActiveMembersBySchool,
  searchActiveMembers,
  createMemberFromOnboarding,
  listPendingMembers,
  decideMembership,
  setNationalAdmin,
  listNationalAdminEmails,
  isBootstrapAdminEmail,
};
