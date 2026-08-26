// api/admin/members/pending.js
// GET /api/admin/members/pending — national admins only.

const { requireNationalAdmin } = require("../../_lib/sessions");
const { listPendingMembers } = require("../../_lib/members-store");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const admin = await requireNationalAdmin(req, res);
  if (!admin) return; // response already sent

  try {
    const pending = await listPendingMembers();
    res.status(200).json({
      pending: pending.map((m) => ({
        id: m.id,
        username: m.username,
        displayName: m.display_name,
        email: m.email,
        profilePictureUrl: m.profile_picture_url,
        schoolName: m.school_name,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error("admin/members/pending error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
