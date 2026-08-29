// api/admin/roles.js
// National admins only. One consolidated route, branching on
// body.action, so this stays a single serverless function as the role
// system grows — see scripts/prune-functions.js for why function count
// is a hard budget here, not just tidiness.
//
// POST /api/admin/roles
// Body shapes, by action:
//   { action: "browse",             schoolId? }                      -> all schools, plus active members of schoolId if given (feeds the admin UI in one call)
//   { action: "browseNational" }                                     -> every active member currently holding at least one national role (club-independent; kept for tooling/future use)
//   { action: "searchMembers",     query }                           -> free-text active-member search across all clubs, to seat someone new onto a national role
//   { action: "list",              memberId }                       -> current + past roles/capabilities for one member
//   { action: "setDisplayRole",    memberId, schoolId, role }        -> ends any current display role for that club, starts the new one
//   { action: "clearDisplayRole",  memberId, schoolId }              -> ends current display role, no replacement
//   { action: "grantCapability",   memberId, schoolId, capability }  -> re-grants if already held (no duplicate)
//   { action: "revokeCapability",  memberId, schoolId, capability }
//   { action: "setNationalRole",   memberId, role }
//   { action: "clearNationalRole", memberId, role }
//
// All mutations require the target member to be "active" — you can't
// assign a role to someone who hasn't been approved onto the platform
// yet, regardless of how eager an admin is to get them set up early.

const { requireNationalAdmin } = require("../_lib/sessions");
const { sql } = require("../_lib/db");
const { findMemberById, listActiveMembersBySchool, listSchools, searchActiveMembers } = require("../_lib/members-store");
const {
  DISPLAY_ROLES,
  CAPABILITIES,
  NATIONAL_ROLES,
  MEMBERSHIP_STATUSES,
  setClubDisplayRole,
  clearClubDisplayRole,
  getCurrentDisplayRole,
  grantCapability,
  revokeCapability,
  getMemberRoleHistory,
  getMemberCapabilities,
  setNationalRole,
  clearNationalRole,
  getMemberNationalRoles,
  getMemberNationalCapabilities,
  grantNationalCapability,
  revokeNationalCapability,
  setMembershipStatus,
  listNationalRoleHolders,
} = require("../_lib/roles");

async function requireActiveTarget(res, memberId) {
  if (!memberId) {
    res.status(400).json({ error: "memberId manquant." });
    return null;
  }
  const target = await findMemberById(memberId);
  if (!target || target.status !== "active") {
    res.status(404).json({ error: "Membre introuvable ou pas encore actif." });
    return null;
  }
  return target;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const admin = await requireNationalAdmin(req, res);
  if (!admin) return;

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: "Corps JSON invalide." });
    return;
  }

  const { action, memberId, schoolId, role, capability } = body || {};

  try {
    switch (action) {
      case "browse": {
        // Feeds the admin UI's school-picker + member-list in one call,
        // so the page doesn't need a separate /api/schools request.
        const schools = await listSchools();
        let members = [];
        if (schoolId) members = await listActiveMembersBySchool(schoolId);
        res.status(200).json({
          ok: true,
          schools,
          members: members.map((m) => ({
            id: m.id,
            username: m.username,
            displayName: m.display_name,
            profilePictureUrl: m.profile_picture_url,
            email: m.email,
            membershipStatus: m.membership_status,
          })),
        });
        return;
      }

      case "browseNational": {
        const members = await listNationalRoleHolders();
        res.status(200).json({ ok: true, members });
        return;
      }

      case "searchMembers": {
        const rows = await searchActiveMembers(body.query);
        res.status(200).json({
          ok: true,
          members: rows.map((m) => ({
            id: m.id,
            username: m.username,
            displayName: m.display_name,
            profilePictureUrl: m.profile_picture_url,
            email: m.email,
          })),
        });
        return;
      }

      case "list": {
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        const [roleHistory, capabilities, nationalRoles, nationalCapabilities, trainerRows, documents] = await Promise.all([
          getMemberRoleHistory(memberId),
          getMemberCapabilities(memberId),
          getMemberNationalRoles(memberId),
          getMemberNationalCapabilities(memberId),
          sql()`select * from portal_trainer_profiles where member_id = ${memberId}`,
          sql()`select id, document_type, title, original_filename, visibility, status, created_at from portal_member_documents where member_id = ${memberId} and status <> 'archived' order by created_at desc`,
        ]);
        res.status(200).json({ ok: true, roleHistory, capabilities, nationalRoles, nationalCapabilities, membershipStatus: target.membership_status, trainerProfile: trainerRows[0] || null, documents });
        return;
      }

      case "setMembershipStatus": {
        if (!MEMBERSHIP_STATUSES.includes(body.membershipStatus)) {
          res.status(400).json({ error: `Statut invalide. Attendu : ${MEMBERSHIP_STATUSES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        const result = await setMembershipStatus({
          memberId,
          status: body.membershipStatus,
          changedBy: admin.id,
          reason: body.reason,
        });
        res.status(200).json({ ok: true, member: result.member, history: result.history });
        return;
      }

      case "setTrainerStatus": {
        const allowed = ["pending", "verified", "suspended"];
        if (!allowed.includes(body.certificationStatus)) {
          res.status(400).json({ error: "Statut Formateur invalide." });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        const db = sql();
        const rows = await db`
          insert into portal_trainer_profiles (member_id, certification_status, verified_by, verified_at, homologated_at)
          values (${memberId}, ${body.certificationStatus}, ${body.certificationStatus === 'verified' ? admin.id : null}, ${body.certificationStatus === 'verified' ? new Date() : null}, ${body.certificationStatus === 'verified' ? new Date() : null})
          on conflict (member_id) do update set certification_status = excluded.certification_status, verified_by = excluded.verified_by, verified_at = excluded.verified_at, homologated_at = excluded.homologated_at, updated_at = now()
          returning *
        `;
        res.status(200).json({ ok: true, trainerProfile: rows[0] });
        return;
      }

      case "setDisplayRole": {
        if (!DISPLAY_ROLES.includes(role)) {
          res.status(400).json({ error: `Rôle invalide. Attendu : ${DISPLAY_ROLES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        if (!schoolId) {
          res.status(400).json({ error: "schoolId manquant." });
          return;
        }
        await setClubDisplayRole({ memberId, schoolId, role, grantedBy: admin.id });
        const current = await getCurrentDisplayRole(memberId, schoolId);
        res.status(200).json({ ok: true, currentRole: current });
        return;
      }

      case "clearDisplayRole": {
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        if (!schoolId) {
          res.status(400).json({ error: "schoolId manquant." });
          return;
        }
        await clearClubDisplayRole({ memberId, schoolId });
        res.status(200).json({ ok: true });
        return;
      }

      case "grantCapability": {
        if (!CAPABILITIES.includes(capability)) {
          res.status(400).json({ error: `Capacité invalide. Attendu : ${CAPABILITIES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        if (!schoolId) {
          res.status(400).json({ error: "schoolId manquant." });
          return;
        }
        const grant = await grantCapability({ memberId, schoolId, capability, grantedBy: admin.id });
        res.status(200).json({ ok: true, grant });
        return;
      }

      case "revokeCapability": {
        if (!CAPABILITIES.includes(capability)) {
          res.status(400).json({ error: `Capacité invalide. Attendu : ${CAPABILITIES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        if (!schoolId) {
          res.status(400).json({ error: "schoolId manquant." });
          return;
        }
        await revokeCapability({ memberId, schoolId, capability });
        res.status(200).json({ ok: true });
        return;
      }

      case "grantNationalCapability": {
        if (capability !== "national_projects") {
          res.status(400).json({ error: "Capacité nationale invalide." });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        const grant = await grantNationalCapability({ memberId, capability, grantedBy: admin.id });
        res.status(200).json({ ok: true, grant });
        return;
      }

      case "revokeNationalCapability": {
        if (capability !== "national_projects") {
          res.status(400).json({ error: "Capacité nationale invalide." });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        await revokeNationalCapability({ memberId, capability });
        res.status(200).json({ ok: true });
        return;
      }

      case "setNationalRole": {
        if (!NATIONAL_ROLES.includes(role)) {
          res.status(400).json({ error: `Rôle national invalide. Attendu : ${NATIONAL_ROLES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        await setNationalRole({ memberId, role, grantedBy: admin.id });
        res.status(200).json({ ok: true });
        return;
      }

      case "clearNationalRole": {
        if (!NATIONAL_ROLES.includes(role)) {
          res.status(400).json({ error: `Rôle national invalide. Attendu : ${NATIONAL_ROLES.join(", ")}` });
          return;
        }
        const target = await requireActiveTarget(res, memberId);
        if (!target) return;
        await clearNationalRole({ memberId, role });
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(400).json({ error: `Action inconnue : ${action}` });
    }
  } catch (err) {
    console.error("admin/roles error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
