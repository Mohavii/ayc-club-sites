// api/session.js
// GET /api/session — used by the static portal pages to find out (client
// side) who's logged in and what their status is, since these are plain
// HTML pages with no server-side rendering.

const { getSessionMember } = require("./_lib/sessions");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const member = await getSessionMember(req);
    if (!member) {
      res.status(200).json({ member: null });
      return;
    }
    res.status(200).json({
      member: {
        id: member.id,
        username: member.username,
        displayName: member.display_name,
        profilePictureUrl: member.profile_picture_url,
        status: member.status,
        isNationalAdmin: member.is_national_admin,
        rejectionNote: member.rejection_note,
      },
    });
  } catch (err) {
    console.error("session error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
