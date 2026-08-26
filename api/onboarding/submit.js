// api/onboarding/submit.js
// POST /api/onboarding/submit
// Body: { username, displayName, schoolId, profilePictureUrl }

const { getSignupIdentity, consumeSignupToken } = require("../_lib/signup-tokens");
const {
  validateUsername,
  findMemberByUsername,
  findMemberByGoogleId,
  createMemberFromOnboarding,
  listNationalAdminEmails,
  listSchools,
} = require("../_lib/members-store");
const { createSession } = require("../_lib/sessions");
const { sendNewRequestNotice } = require("../_lib/mailer");
const { getCapabilityHolders } = require("../_lib/roles");

function isTrustedProfileUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return u.hostname.endsWith(".public.blob.vercel-storage.com")
      || u.hostname === "lh3.googleusercontent.com"
      || u.hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: "Corps JSON invalide." });
    return;
  }

  const username = String(body?.username || "").trim().toLowerCase();
  const displayName = String(body?.displayName || "").trim();
  const schoolId = Number(body?.schoolId);
  const requestedPictureUrl = body?.profilePictureUrl ? String(body.profilePictureUrl) : null;

  try {
    const identity = await getSignupIdentity(req);
    if (!identity) {
      res.status(401).json({ error: "Session d'inscription expirée. Reconnecte-toi avec Google." });
      return;
    }

    // Someone could complete Google sign-in twice before finishing
    // onboarding once; guard against a duplicate member for this Google id.
    const alreadyExists = await findMemberByGoogleId(identity.google_id);
    if (alreadyExists) {
      await consumeSignupToken(res, identity._tokenHash);
      res.status(409).json({ error: "Un compte existe déjà pour ce compte Google." });
      return;
    }

    const usernameError = validateUsername(username);
    if (usernameError) {
      res.status(400).json({ error: usernameError });
      return;
    }
    if (await findMemberByUsername(username)) {
      res.status(400).json({ error: "Ce nom d'utilisateur est déjà pris." });
      return;
    }

    if (!displayName || displayName.length > 120) {
      res.status(400).json({ error: "Nom d'affichage invalide." });
      return;
    }

    const schools = await listSchools();
    const school = schools.find((s) => s.id === schoolId);
    if (!school) {
      res.status(400).json({ error: "École/club invalide." });
      return;
    }

    // Prefer a manually uploaded Blob image, but fall back to the verified
    // Google avatar stored in the signup token when no manual photo was chosen.
    const profilePictureUrl = requestedPictureUrl || identity.google_picture || null;
    if (profilePictureUrl && !isTrustedProfileUrl(profilePictureUrl)) {
      res.status(400).json({ error: "Photo de profil invalide." });
      return;
    }

    const member = await createMemberFromOnboarding({
      googleId: identity.google_id,
      email: identity.email,
      username,
      displayName,
      profilePictureUrl,
      schoolId: school.id,
    });

    await consumeSignupToken(res, identity._tokenHash);
    await createSession(res, member.id, req.headers["user-agent"]);

    if (member.status === "pending") {
      const approvers = await getCapabilityHolders(school.id, "membership_approver");
      const emails = approvers.map((approver) => approver.email).filter(Boolean);
      // Keep the first-admin/bootstrap path safe if a club has not yet been
      // assigned a membership approver.
      const recipients = emails.length > 0 ? emails : await listNationalAdminEmails();
      if (recipients.length > 0) await sendNewRequestNotice(recipients, member, school.name);
    }

    res.status(200).json({ ok: true, status: member.status });
  } catch (err) {
    console.error("onboarding/submit error:", err);
    res.status(500).json({ error: "Une erreur interne est survenue." });
  }
};
