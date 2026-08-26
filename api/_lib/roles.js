// roles.js
//
// All reads/writes for the three role tables added alongside the
// original schema — see the big comment block above them in
// db/schema.sql for the full rationale. Quick recap:
//
//   - portal_club_display_roles : one CURRENT role per (member, club),
//     shown as a profile badge. History = past rows with ended_at set.
//   - portal_capability_grants  : stackable, backend-only permissions
//     per club. Independent of display roles — never inferred from one.
//   - portal_national_roles     : org titles with no club scope at all,
//     independent of portal_members.is_national_admin.
//
// Every route that gates a feature (PV editing, report validation,
// membership approval, meeting creation, ...) should go through the
// requireCapability / requireDisplayRole guards below rather than
// re-implementing its own check — that's what keeps "granular,
// per-capability, per-club" honest instead of drifting back into a
// hardcoded hierarchy as features get added.

const { sql } = require("./db");

const DISPLAY_ROLES = ["president", "tresorier", "secretaire", "vpi", "vpe", "vpc", "supco_regional"];
const CAPABILITIES = ["membership_approver", "report_validator", "pv_editor", "meeting_organizer"];
const NATIONAL_ROLES = ["president_national"];
const MEMBERSHIP_STATUSES = ["nouveau_adherent", "adherent", "responsable", "senior", "membre_national", "ancien"];

function assertValidMembershipStatus(status) {
  if (!MEMBERSHIP_STATUSES.includes(status)) throw new Error(`Statut d'adhésion inconnu : ${status}`);
}

function assertValidDisplayRole(role) {
  if (!DISPLAY_ROLES.includes(role)) throw new Error(`Rôle d'affichage inconnu : ${role}`);
}
function assertValidCapability(capability) {
  if (!CAPABILITIES.includes(capability)) throw new Error(`Capacité inconnue : ${capability}`);
}
function assertValidNationalRole(role) {
  if (!NATIONAL_ROLES.includes(role)) throw new Error(`Rôle national inconnu : ${role}`);
}

// ---- Club display roles -----------------------------------------------

// Ends the member's current display role for a club (if any) and starts
// a new one, in one transaction — this pair of writes IS the history:
// the ended row stays forever as a past-tenure record.
async function setClubDisplayRole({ memberId, schoolId, role, grantedBy }) {
  assertValidDisplayRole(role);
  const db = sql();
  return db.transaction((tx) => [
    tx`
      update portal_club_display_roles
      set ended_at = now()
      where member_id = ${memberId} and school_id = ${schoolId} and ended_at is null
    `,
    tx`
      insert into portal_club_display_roles (member_id, school_id, role, granted_by)
      values (${memberId}, ${schoolId}, ${role}, ${grantedBy})
      returning *
    `,
  ]);
}

// Clears whoever currently holds a display role for a club, without
// assigning a replacement (e.g. a Président steps down with no
// successor yet).
async function clearClubDisplayRole({ memberId, schoolId }) {
  const db = sql();
  await db`
    update portal_club_display_roles
    set ended_at = now()
    where member_id = ${memberId} and school_id = ${schoolId} and ended_at is null
  `;
}

async function getCurrentDisplayRole(memberId, schoolId) {
  const db = sql();
  const rows = await db`
    select * from portal_club_display_roles
    where member_id = ${memberId} and school_id = ${schoolId} and ended_at is null
  `;
  return rows[0] || null;
}

// Everyone currently holding a given role at a club — normally 0 or 1
// row given the DB-level exclusivity constraint, but returning an array
// keeps the caller honest rather than assuming exactly one exists.
async function getCurrentHolders(schoolId, role) {
  assertValidDisplayRole(role);
  const db = sql();
  return db`
    select m.*, r.started_at as role_started_at
    from portal_club_display_roles r
    join portal_members m on m.id = r.member_id
    where r.school_id = ${schoolId} and r.role = ${role} and r.ended_at is null
  `;
}

// "Historique des postes occupés" — every role (current + past) a
// member has held, across every club, most recent first.
async function getMemberRoleHistory(memberId) {
  const db = sql();
  return db`
    select r.*, s.name as school_name, s.slug as school_slug
    from portal_club_display_roles r
    join portal_schools s on s.id = r.school_id
    where r.member_id = ${memberId}
    order by r.started_at desc
  `;
}

// ---- Capability grants ---------------------------------------------

async function grantCapability({ memberId, schoolId, capability, grantedBy }) {
  assertValidCapability(capability);
  const db = sql();
  // Revoke any existing active grant of this exact capability for this
  // member+club first, so re-granting doesn't create duplicate active
  // rows (no DB-level exclude constraint here since, unlike display
  // roles, different capabilities on the same club are meant to
  // coexist — only the SAME capability shouldn't double up).
  await db`
    update portal_capability_grants
    set revoked_at = now()
    where member_id = ${memberId} and school_id = ${schoolId}
      and capability = ${capability} and revoked_at is null
  `;
  const rows = await db`
    insert into portal_capability_grants (member_id, school_id, capability, granted_by)
    values (${memberId}, ${schoolId}, ${capability}, ${grantedBy})
    returning *
  `;
  return rows[0];
}

async function revokeCapability({ memberId, schoolId, capability }) {
  assertValidCapability(capability);
  const db = sql();
  await db`
    update portal_capability_grants
    set revoked_at = now()
    where member_id = ${memberId} and school_id = ${schoolId}
      and capability = ${capability} and revoked_at is null
  `;
}

async function hasCapability(memberId, schoolId, capability) {
  assertValidCapability(capability);
  const db = sql();
  const rows = await db`
    select 1 from portal_capability_grants
    where member_id = ${memberId} and school_id = ${schoolId}
      and capability = ${capability} and revoked_at is null
    limit 1
  `;
  return rows.length > 0;
}

// Every active grant a member currently holds, across all clubs — used
// to build e.g. the member's own permissions summary in their profile.
async function getMemberCapabilities(memberId) {
  const db = sql();
  return db`
    select g.*, s.name as school_name, s.slug as school_slug
    from portal_capability_grants g
    join portal_schools s on s.id = g.school_id
    where g.member_id = ${memberId} and g.revoked_at is null
  `;
}

async function getCapabilityHolders(schoolId, capability) {
  assertValidCapability(capability);
  const db = sql();
  return db`
    select m.*
    from portal_capability_grants g
    join portal_members m on m.id = g.member_id
    where g.school_id = ${schoolId} and g.capability = ${capability} and g.revoked_at is null
  `;
}

// ---- National roles ----------------------------------------------------

async function setNationalRole({ memberId, role, grantedBy }) {
  assertValidNationalRole(role);
  const db = sql();
  return db.transaction((tx) => [
    tx`
      update portal_national_roles
      set ended_at = now()
      where member_id = ${memberId} and role = ${role} and ended_at is null
    `,
    tx`
      insert into portal_national_roles (member_id, role, granted_by)
      values (${memberId}, ${role}, ${grantedBy})
      returning *
    `,
  ]);
}

async function clearNationalRole({ memberId, role }) {
  assertValidNationalRole(role);
  const db = sql();
  await db`
    update portal_national_roles
    set ended_at = now()
    where member_id = ${memberId} and role = ${role} and ended_at is null
  `;
}

async function getMemberStatusHistory(memberId) {
  const db = sql();
  return db`
    select h.*, m.display_name as changed_by_name
    from portal_member_status_history h
    left join portal_members m on m.id = h.changed_by
    where h.member_id = ${memberId}
    order by h.changed_at desc
  `;
}

async function setMembershipStatus({ memberId, status, changedBy, reason }) {
  assertValidMembershipStatus(status);
  const db = sql();
  const result = await db.transaction((tx) => [
    tx`
      update portal_members
      set membership_status = ${status}
      where id = ${memberId}
      returning *
    `,
    tx`
      insert into portal_member_status_history (member_id, status, changed_by, reason)
      values (${memberId}, ${status}, ${changedBy || null}, ${reason || null})
      returning *
    `,
  ]);
  return { member: result[0][0], history: result[1][0] };
}

async function getMemberNationalRoles(memberId) {
  const db = sql();
  return db`
    select * from portal_national_roles
    where member_id = ${memberId} and ended_at is null
  `;
}

// ---- HTTP route guards --------------------------------------------------
// Same pattern as sessions.js's requireActiveMember/requireNationalAdmin:
// writes the response and returns null on failure, so a route handler
// can just do `if (!member) return;` and continue otherwise.

function requireCapability(capability) {
  assertValidCapability(capability);
  return async function guard(req, res, activeMember, schoolId) {
    if (!schoolId) {
      res.status(400).json({ error: "school_id manquant." });
      return false;
    }
    // National admins can act everywhere — a portal-management
    // override, not a capability grant, kept as its own explicit check
    // rather than silently inserting a grant row on their behalf.
    if (activeMember.is_national_admin) return true;
    const ok = await hasCapability(activeMember.id, schoolId, capability);
    if (!ok) {
      res.status(403).json({ error: "Vous n'avez pas cette permission pour ce club." });
      return false;
    }
    return true;
  };
}

function requireDisplayRole(roles) {
  const list = Array.isArray(roles) ? roles : [roles];
  list.forEach(assertValidDisplayRole);
  return async function guard(req, res, activeMember, schoolId) {
    if (!schoolId) {
      res.status(400).json({ error: "school_id manquant." });
      return false;
    }
    if (activeMember.is_national_admin) return true;
    const current = await getCurrentDisplayRole(activeMember.id, schoolId);
    if (!current || !list.includes(current.role)) {
      res.status(403).json({ error: "Réservé au Président ou Secrétaire de ce club." });
      return false;
    }
    return true;
  };
}

module.exports = {
  DISPLAY_ROLES,
  CAPABILITIES,
  NATIONAL_ROLES,
  MEMBERSHIP_STATUSES,
  assertValidMembershipStatus,
  setClubDisplayRole,
  clearClubDisplayRole,
  getCurrentDisplayRole,
  getCurrentHolders,
  getMemberRoleHistory,
  grantCapability,
  revokeCapability,
  hasCapability,
  getMemberCapabilities,
  getCapabilityHolders,
  setNationalRole,
  clearNationalRole,
  getMemberNationalRoles,
  getMemberStatusHistory,
  setMembershipStatus,
  requireCapability,
  requireDisplayRole,
};
