// GET /api/admin/members/pending
// National admins see all requests; club membership_approvers see their club only.
const { sql } = require("../../_lib/db");
const { requireActiveMember } = require("../../_lib/sessions");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const viewer = await requireActiveMember(req, res);
  if (!viewer) return;
  try {
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
            and exists (
              select 1 from portal_capability_grants g
              where g.member_id = ${viewer.id}
                and g.school_id = m.school_id
                and g.capability = 'membership_approver'
                and g.revoked_at is null
            )
          order by m.created_at asc
        `;
    res.status(200).json({ pending: pending.map((m) => ({
      id: m.id, username: m.username, displayName: m.display_name, email: m.email,
      profilePictureUrl: m.profile_picture_url, schoolName: m.school_name, createdAt: m.created_at,
    })) });
  } catch (err) {
    console.error("admin/members/pending error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
