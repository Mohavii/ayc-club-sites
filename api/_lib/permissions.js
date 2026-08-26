// permissions.js
//
// Two roles:
//  - National admin: identified by Discord ROLE (set NATIONAL_ADMIN_ROLE_ID
//    env var to your Discord server's admin role ID). Can approve/reject
//    pending edits, and can also submit edits for any club directly.
//  - VPC / local officer: identified either of two ways —
//      1. Holding the club's own Discord role (e.g. "VPC - LPSE"),
//         auto-created when the club was approved, stored as
//         club.vpcRoleId. This is the primary mechanism: national admins
//         assign/remove this role by season, and whoever holds it can
//         edit that club — no per-person list to maintain.
//      2. The older per-club "officers" user-ID list, kept as a fallback
//         for clubs created before role-based access existed, or for
//         manual overrides.
//    Either one grants the same access; a person only needs to match one.

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

function hasClubVpcRole(club, interaction) {
  if (!club || !club.vpcRoleId) return false;
  const memberRoles = interaction.member && interaction.member.roles;
  return Array.isArray(memberRoles) && memberRoles.includes(club.vpcRoleId);
}

// Returns { allowed: boolean, isAdmin: boolean, reason?: string }
function checkClubEditPermission(interaction, club) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const admin = isNationalAdmin(interaction);
  if (admin) return { allowed: true, isAdmin: true };
  if (hasClubVpcRole(club, interaction)) return { allowed: true, isAdmin: false };
  if (isClubOfficer(club, userId)) return { allowed: true, isAdmin: false };
  return {
    allowed: false,
    isAdmin: false,
    reason:
      "Tu n'as pas le rôle VPC de ce club, et tu n'as pas le rôle admin national. Demande à un·e admin national·e de te donner le rôle du club.",
  };
}

module.exports = { isNationalAdmin, isClubOfficer, hasClubVpcRole, checkClubEditPermission };
