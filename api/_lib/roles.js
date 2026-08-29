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
const BEL_ROLES = ["president", "tresorier", "secretaire", "vpi", "vpe", "vpc"];
const CAPABILITIES = ["membership_approver", "report_validator", "pv_editor", "meeting_organizer", "project_manager", "supervision_editor", "cscy_reviewer"];
// 'epn_member' seats someone on the Équipe Plénière Nationale (EPN), the
// standing body listed as attendees on every national AG — many members
// hold this at once, unlike a single-seat title. 'secretaire_national' is
// the national-scope counterpart of the club 'secretaire' display role:
// it lets whoever holds it write the national AG's PV (see
// requirePvEditorForAssembly below) without needing the pv_editor
// capability, since that capability is meant for local club PVs.
// BEN posts (Trésorier National, VPA, VPR, VPCOM) and the Conseil de
// Supervision's national seat (SUPCO) added alongside président_national so
// the "Liste de présence du BEN et du Conseil de Supervision" on national AG
// PVs can be driven from real member roles instead of free text — a vacant
// post is simply "no current row for that role".
const NATIONAL_ROLES = ["president_national", "epn_member", "secretaire_national", "secretaire_general_national", "tresorier_national", "vpa", "vpr", "vpcom", "supco_national"];
const BEN_ROLE_LABELS = {
  president_national: "Président National",
  secretaire_general_national: "Secrétaire Générale Nationale",
  tresorier_national: "Trésorier National",
  vpa: "VPA",
  vpr: "VPR",
  vpcom: "VPCOM",
  supco_national: "SUPCO",
};
// Order the BEN/SupCo roster is presented in, matching the paper PV.
const BEN_ROSTER_ROLES = ["president_national", "secretaire_general_national", "tresorier_national", "vpa", "vpr", "vpcom", "supco_national"];
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

async function grantNationalCapability({ memberId, capability, grantedBy }) {
  if (capability !== 'national_projects') throw new Error(`Capacité nationale inconnue : ${capability}`);
  const db = sql();
  await db`
    update portal_national_capability_grants
    set revoked_at = now()
    where member_id = ${memberId} and capability = ${capability} and revoked_at is null
  `;
  const rows = await db`
    insert into portal_national_capability_grants (member_id, capability, granted_by)
    values (${memberId}, ${capability}, ${grantedBy})
    returning *
  `;
  return rows[0];
}

async function revokeNationalCapability({ memberId, capability }) {
  if (capability !== 'national_projects') throw new Error(`Capacité nationale inconnue : ${capability}`);
  const db = sql();
  await db`
    update portal_national_capability_grants
    set revoked_at = now()
    where member_id = ${memberId} and capability = ${capability} and revoked_at is null
  `;
}

async function hasNationalCapability(memberId, capability) {
  if (capability !== 'national_projects') throw new Error(`Capacité nationale inconnue : ${capability}`);
  const db = sql();
  const rows = await db`
    select 1 from portal_national_capability_grants
    where member_id = ${memberId} and capability = ${capability} and revoked_at is null
    limit 1
  `;
  return rows.length > 0;
}

async function getMemberNationalCapabilities(memberId) {
  const db = sql();
  return db`
    select * from portal_national_capability_grants
    where member_id = ${memberId} and revoked_at is null
    order by granted_at desc
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
      and m.status = 'active'
  `;
}

// Membership requests are a club-governance workflow. National admins can
// review every club; an explicit membership_approver grant or the club's
// current VPC can review requests for that club. Keeping this rule in one
// helper prevents the list, decision, session shell, and email notice from
// drifting apart.
async function canReviewMembership(memberId, schoolId) {
  const db = sql();
  const rows = await db`
    select 1
    from portal_members m
    where m.id = ${memberId}
      and m.status = 'active'
      and (
        m.is_national_admin = true
        or exists (
          select 1 from portal_capability_grants g
          where g.member_id = m.id and g.school_id = ${schoolId}
            and g.capability = 'membership_approver' and g.revoked_at is null
        )
        or exists (
          select 1 from portal_club_display_roles r
          where r.member_id = m.id and r.school_id = ${schoolId}
            and r.role = 'vpc' and r.ended_at is null
        )
      )
    limit 1
  `;
  return rows.length > 0;
}

async function getMemberPortalAccess(member) {
  const db = sql();
  const schoolId = member.school_id || null;
  const [roleRows, capabilityRows, nationalCapabilityRows, trainerRows, nationalRoleRows] = await Promise.all([
    schoolId ? db`select role from portal_club_display_roles where member_id = ${member.id} and school_id = ${schoolId} and ended_at is null limit 1` : Promise.resolve([]),
    schoolId ? db`select capability from portal_capability_grants where member_id = ${member.id} and school_id = ${schoolId} and revoked_at is null` : Promise.resolve([]),
    db`select capability from portal_national_capability_grants where member_id = ${member.id} and revoked_at is null`,
    db`select certification_status from portal_trainer_profiles where member_id = ${member.id} limit 1`,
    db`select role from portal_national_roles where member_id = ${member.id} and ended_at is null`,
  ]);
  const displayRole = roleRows[0]?.role || null;
  const capabilities = capabilityRows.map(row => row.capability);
  const isNationalAdmin = Boolean(member.is_national_admin);
  const isVerifiedTrainer = trainerRows[0]?.certification_status === "verified";
  const nationalCapabilities = nationalCapabilityRows.map(row => row.capability);
  const nationalRoles = nationalRoleRows.map(row => row.role);
  const has = capability => isNationalAdmin || capabilities.includes(capability);
  const hasNational = capability => isNationalAdmin || nationalCapabilities.includes(capability);
  // 'secretaire_national' writes national AG PVs on its own merit — it
  // is NOT folded into canEditPV, which several other screens (reports,
  // local meetings) treat as "holds the local pv_editor capability".
  // Assemblies.html checks this flag specifically for national scope.
  const isNationalSecretary = isNationalAdmin || nationalRoles.includes("secretaire_national");
  const isEpnMember = isNationalAdmin || nationalRoles.includes("epn_member");
  const isNewAdherent = member.membership_status === "nouveau_adherent";
  const isOrdinaryMember = !isNationalAdmin && !BEL_ROLES.includes(displayRole) && capabilities.length === 0;
  const canManageClubWork = isNationalAdmin || capabilities.some(capability => ["meeting_organizer", "pv_editor", "project_manager", "report_validator"].includes(capability));
  return {
    displayRole,
    capabilities,
    isNewAdherent,
    isOrdinaryMember,
    isClubOfficer: BEL_ROLES.includes(displayRole),
    isVerifiedTrainer,
    canViewClubWork: canManageClubWork,
    canCreateMeeting: has("meeting_organizer"),
    canEditPV: has("pv_editor"),
    canCreateProject: has("project_manager"),
    canCreateNationalProject: hasNational("national_projects"),
    nationalCapabilities,
    nationalRoles,
    isNationalSecretary,
    isEpnMember,
    canReviewReports: has("report_validator"),
    canManageSupervision: has("supervision_editor"),
    canReviewSupervision: has("supervision_editor") || has("cscy_reviewer"),
    canCreateAssembly: has("meeting_organizer"),
    canEditAssemblyAttendance: has("cscy_reviewer"),
    canCloseAssembly: has("supervision_editor") || has("cscy_reviewer"),
    canEditTrainingRecord: isNationalAdmin || isVerifiedTrainer,
    canSubmitTrainingParticipation: !isNationalAdmin && !isVerifiedTrainer,
    canCreateReport: isNationalAdmin || capabilities.includes("report_validator") || capabilities.includes("supervision_editor"),
  };
}

async function canReviewAnyMembership(memberId) {
  const db = sql();
  const rows = await db`
    select 1 from portal_members m
    where m.id = ${memberId} and m.status = 'active'
      and (
        m.is_national_admin = true
        or exists (select 1 from portal_capability_grants g where g.member_id = m.id and g.capability = 'membership_approver' and g.revoked_at is null)
        or exists (select 1 from portal_club_display_roles r where r.member_id = m.id and r.role = 'vpc' and r.ended_at is null)
      )
    limit 1
  `;
  return rows.length > 0;
}

async function getMembershipReviewers(schoolId) {
  const db = sql();
  return db`
    select distinct m.*
    from portal_members m
    where m.status = 'active'
      and (
        m.is_national_admin = true
        or exists (
          select 1 from portal_capability_grants g
          where g.member_id = m.id and g.school_id = ${schoolId}
            and g.capability = 'membership_approver' and g.revoked_at is null
        )
        or exists (
          select 1 from portal_club_display_roles r
          where r.member_id = m.id and r.school_id = ${schoolId}
            and r.role = 'vpc' and r.ended_at is null
        )
      )
    order by m.is_national_admin desc, m.display_name asc
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

// Every active member holding at least one current national role, each
// with the full list of national roles they currently hold — feeds the
// admin "Équipe Plénière Nationale" tab, which manages national roles
// directly instead of requiring an admin to first pick a club (national
// roles have no club scope, see the big comment above NATIONAL_ROLES).
async function listNationalRoleHolders() {
  const db = sql();
  const rows = await db`
    select m.id, m.username, m.display_name as "displayName", m.profile_picture_url as "profilePictureUrl",
      r.role, r.started_at
    from portal_national_roles r
    join portal_members m on m.id = r.member_id
    where r.ended_at is null and m.status = 'active'
    order by m.display_name asc, r.started_at asc
  `;
  const byMember = new Map();
  for (const row of rows) {
    if (!byMember.has(row.id)) {
      byMember.set(row.id, {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        profilePictureUrl: row.profilePictureUrl,
        roles: [],
      });
    }
    byMember.get(row.id).roles.push(row.role);
  }
  return [...byMember.values()];
}

// Whether a member currently holds a given national-scope title —
// national admins are NOT auto-granted these (unlike capabilities):
// EPN membership and the national secretary title are seats, not admin
// overrides, so who counts as "on the EPN" stays exactly who's been
// seated there.
async function hasNationalRole(memberId, role) {
  assertValidNationalRole(role);
  const db = sql();
  const rows = await db`
    select 1 from portal_national_roles
    where member_id = ${memberId} and role = ${role} and ended_at is null
    limit 1
  `;
  return rows.length > 0;
}

// Everyone currently seated on the Équipe Plénière Nationale — the
// standing roster auto-listed as attendees whenever a national AG is
// opened, the same way BEL/BEN office holders anchor a local assembly.
async function getEpnMembers() {
  const db = sql();
  return db`
    select m.*, r.started_at as role_started_at
    from portal_national_roles r
    join portal_members m on m.id = r.member_id
    where r.role = 'epn_member' and r.ended_at is null and m.status = 'active'
    order by m.display_name asc
  `;
}

// Full "BEN et Conseil de Supervision" roster in paper-PV order, one row
// per post — vacant posts come back as { role, holder: null } instead of
// being silently dropped, matching the paper PV's red "Vacant" rows.
async function getBenRoster() {
  const db = sql();
  const rows = await db`
    select r.role, m.id as member_id, m.display_name, m.username
    from portal_national_roles r
    join portal_members m on m.id = r.member_id
    where r.role = any(${BEN_ROSTER_ROLES}) and r.ended_at is null and m.status = 'active'
  `;
  const byRole = new Map(rows.map(row => [row.role, row]));
  return BEN_ROSTER_ROLES.map(role => ({
    role,
    label: BEN_ROLE_LABELS[role],
    holder: byRole.has(role) ? { id: byRole.get(role).member_id, displayName: byRole.get(role).display_name, username: byRole.get(role).username } : null,
  }));
}

// Auto-fills a "PI" role label for a member: national title first (matches
// the paper PV's "(Responsable LIAYC)" / "(Entité des membres nationaux)"
// style), then club display role, else the membership status itself.
async function getMemberRoleLabel(memberId) {
  const db = sql();
  const [nationalRows, clubRows, memberRows] = await Promise.all([
    db`select role from portal_national_roles where member_id = ${memberId} and ended_at is null limit 1`,
    db`select r.role, s.name as school_name from portal_club_display_roles r join portal_schools s on s.id = r.school_id where r.member_id = ${memberId} and r.ended_at is null limit 1`,
    db`select display_name, membership_status from portal_members where id = ${memberId} limit 1`,
  ]);
  const clubRoleLabels = { president: "Président(e)", tresorier: "Trésorier(e)", secretaire: "Secrétaire", vpi: "VPI", vpe: "VPE", vpc: "VPC", supco_regional: "SupCo Régional" };
  if (nationalRows[0]) return BEN_ROLE_LABELS[nationalRows[0].role] || nationalRows[0].role;
  if (clubRows[0]) return `${clubRoleLabels[clubRows[0].role] || clubRows[0].role} · ${clubRows[0].school_name}`;
  if (memberRows[0]?.membership_status === "senior") return "Conseil National des Seniors";
  if (memberRows[0]?.membership_status === "membre_national") return "Entité des membres nationaux";
  return memberRows[0] ? "Membre" : null;
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
  BEL_ROLES,
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
  grantNationalCapability,
  revokeNationalCapability,
  hasNationalCapability,
  getMemberNationalCapabilities,
  getMemberCapabilities,
  getCapabilityHolders,
  getMemberPortalAccess,
  canReviewMembership,
  canReviewAnyMembership,
  getMembershipReviewers,
  setNationalRole,
  clearNationalRole,
  getMemberNationalRoles,
  hasNationalRole,
  getEpnMembers,
  listNationalRoleHolders,
  getMemberStatusHistory,
  setMembershipStatus,
  requireCapability,
  requireDisplayRole,
  BEN_ROLE_LABELS,
  BEN_ROSTER_ROLES,
  getBenRoster,
  getMemberRoleLabel,
};
