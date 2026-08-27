// Consolidated portal-auth route for membership requests.
// GET  /api/admin/members?action=pending
// POST /api/admin/members { memberId, decision: "approve" | "reject", rejectionNote? }
// National admins see all requests; a club's current VPC and explicit
// membership_approvers see requests for their club only.

const { sql } = require("../_lib/db");
const { requireActiveMember } = require("../_lib/sessions");
const { canReviewMembership, canReviewAnyMembership } = require("../_lib/roles");
const { decideMembership } = require("../_lib/members-store");
const { sendApprovalEmail, sendRejectionEmail } = require("../_lib/mailer");

module.exports = async (req, res) => {
  const viewer = await requireActiveMember(req, res);
  if (!viewer) return;

  try {
    if (req.method === "GET") return listPending(viewer, res);
    if (req.method === "POST") return decide(req, viewer, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin/members error:", err);
    return res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};

async function listPending(viewer, res) {
  if (!viewer.is_national_admin && !(await canReviewAnyMembership(viewer.id))) {
    return res.status(403).json({ error: "Cette page est réservée aux admins nationaux et aux VPC responsables d’un club." });
  }

  const db = sql();
  const pending = viewer.is_national_admin
    ? await db`
        select m.*, s.name as school_name
        from portal_members m left join portal_schools s on s.id = m.school_id
        where m.status = 'pending' order by m.created_at asc
      `
    : await db`
        select m.*, s.name as school_name
        from portal_members m
        left join portal_schools s on s.id = m.school_id
        where m.status = 'pending'
          and (
            exists (
              select 1 from portal_capability_grants g
              where g.member_id = ${viewer.id}
                and g.school_id = m.school_id
                and g.capability = 'membership_approver'
                and g.revoked_at is null
            )
            or exists (
              select 1 from portal_club_display_roles r
              where r.member_id = ${viewer.id}
                and r.school_id = m.school_id
                and r.role = 'vpc'
                and r.ended_at is null
            )
          )
        order by m.created_at asc
      `;

  return res.status(200).json({
    canReview: true,
    scope: viewer.is_national_admin ? "national" : "club",
    pending: pending.map(formatPending),
  });
}

async function decide(req, approver, res) {
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "Corps JSON invalide." });
  }

  const { memberId, decision, rejectionNote } = body;
  if (!memberId || !["approve", "reject"].includes(decision)) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  const db = sql();
  const rows = await db`
    select m.*, s.name as school_name
    from portal_members m left join portal_schools s on s.id = m.school_id
    where m.id = ${memberId} and m.status = 'pending'
  `;
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "Demande introuvable ou déjà traitée." });
  if (!(await canReviewMembership(approver.id, target.school_id))) {
    return res.status(403).json({ error: "Vous n’êtes pas admin national, VPC responsable ou approbateur·rice de ce club." });
  }

  const updated = await decideMembership({ memberId, decision, decidedBy: approver.id, rejectionNote });
  if (!updated) return res.status(409).json({ error: "Cette demande a déjà été traitée." });
  if (decision === "approve") await sendApprovalEmail(updated);
  else await sendRejectionEmail(updated);
  return res.status(200).json({ ok: true, status: updated.status });
}

function formatPending(m) {
  return {
    id: m.id,
    username: m.username,
    displayName: m.display_name,
    email: m.email,
    profilePictureUrl: m.profile_picture_url,
    schoolId: m.school_id,
    schoolName: m.school_name,
    createdAt: m.created_at,
  };
}
