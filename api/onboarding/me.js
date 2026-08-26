// api/onboarding/me.js
// GET /api/onboarding/me — returns the Google name/picture/email to
// pre-fill the onboarding form, proven by the signup-token cookie set at
// the end of api/auth/google/callback.js. No member row exists yet.

const { getSignupIdentity } = require("../_lib/signup-tokens");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const identity = await getSignupIdentity(req);
    if (!identity) {
      res.status(401).json({ error: "Session d'inscription expirée. Reconnecte-toi avec Google." });
      return;
    }
    res.status(200).json({
      email: identity.email,
      suggestedName: identity.google_name,
      googlePicture: identity.google_picture,
    });
  } catch (err) {
    console.error("onboarding/me error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
