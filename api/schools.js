// api/schools.js
// GET /api/schools — public list of schools/clubs for the onboarding form.

const { listSchools } = require("./_lib/members-store");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const schools = await listSchools();
    res.status(200).json({ schools });
  } catch (err) {
    console.error("schools error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
