// api/onboarding/check-username.js
// GET /api/onboarding/check-username?u=someusername

const { validateUsername, findMemberByUsername } = require("../_lib/members-store");
const { getSignupIdentity } = require("../_lib/signup-tokens");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Requires a live signup session — this endpoint isn't meant to be a
  // general-purpose username enumeration tool for anonymous callers.
  const identity = await getSignupIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "Session d'inscription expirée." });
    return;
  }

  const username = String((req.query && req.query.u) || "").toLowerCase();
  const invalidReason = validateUsername(username);
  if (invalidReason) {
    res.status(200).json({ available: false, reason: invalidReason });
    return;
  }

  try {
    const existing = await findMemberByUsername(username);
    res.status(200).json({
      available: !existing,
      reason: existing ? "Ce nom d'utilisateur est déjà pris." : null,
    });
  } catch (err) {
    console.error("check-username error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
