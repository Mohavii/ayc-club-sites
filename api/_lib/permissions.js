// permissions.js
//
// Two roles:
//  - National admin: identified by Discord ROLE (set NATIONAL_ADMIN_ROLE_ID
//    env var to your Discord server's admin role ID). Can approve/reject
//    pending edits, and can also submit edits for any club directly.
//  - VPC / local officer: identified per-club, by Discord user ID, stored
//    in that club's own JSON record under "officers". Can only submit
//    edits for their own club(s), and those edits always go to review.

function isNationalAdmin(interaction) {
  const adminRoleId = process.env.NATIONAL_ADMIN_ROLE_ID;
  if (!adminRoleId) return false;
  const memberRoles = interaction.member && interaction.member.roles;
  return Array.isArray(memberRoles) && memberRoles.includes(adminRoleId);
}

function isClubOfficer(club, userId) {
  if (!club || !Array.isArray(club.officers)) return false;
  return club.officers.includes(userId);
}

// Returns { allowed: boolean, isAdmin: boolean, reason?: string }
function checkClubEditPermission(interaction, club) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const admin = isNationalAdmin(interaction);
  if (admin) return { allowed: true, isAdmin: true };
  if (isClubOfficer(club, userId)) return { allowed: true, isAdmin: false };
  return {
    allowed: false,
    isAdmin: false,
    reason:
      "Tu n'es pas enregistré·e comme responsable (VPC) de ce club, et tu n'as pas le rôle admin national. Demande à un·e admin national·e de t'ajouter.",
  };
}

module.exports = { isNationalAdmin, isClubOfficer, checkClubEditPermission };
