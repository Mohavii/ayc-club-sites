// scripts/seed-local-test.js
//
// FAST LOCAL TESTING ONLY. Bypasses Google OAuth entirely: inserts two
// portal_members rows directly, gives one the "project_manager" capability
// on a school, creates a project + team so task-assignment's prerequisites
// are satisfied, and mints two real portal_sessions rows so you can just
// paste a cookie into two browser windows and be logged in as each one.
//
// Usage:
//   DATABASE_URL="postgresql://..." node scripts/seed-local-test.js
//
// Re-run any time — it's idempotent-ish (uses fixed google_id/username so
// re-running updates the same two rows instead of piling up duplicates).

const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("Set DATABASE_URL first.");
    process.exit(1);
  }
  const sql = neon(DATABASE_URL);

  // 1. Make sure there's at least one school to attach members to.
  let [school] = await sql`select id, name from portal_schools order by id limit 1`;
  if (!school) {
    [school] = await sql`
      insert into portal_schools (slug, name, is_active)
      values ('test-club', 'Test Club (local)', true)
      returning id, name
    `;
    console.log(`Created placeholder school: ${school.name} (id=${school.id})`);
  } else {
    console.log(`Using existing school: ${school.name} (id=${school.id})`);
  }

  // 2. Upsert the two test members.
  const [pm] = await sql`
    insert into portal_members
      (google_id, email, username, display_name, school_id, status, membership_status)
    values
      ('local-test-pm', 'pm@test.local', 'test_pm', 'Test PM', ${school.id}, 'active', 'responsable')
    on conflict (google_id) do update set status = 'active', school_id = ${school.id}
    returning id, display_name
  `;
  const [member] = await sql`
    insert into portal_members
      (google_id, email, username, display_name, school_id, status, membership_status)
    values
      ('local-test-member', 'member@test.local', 'test_member', 'Test Member', ${school.id}, 'active', 'adherent')
    on conflict (google_id) do update set status = 'active', school_id = ${school.id}
    returning id, display_name
  `;
  console.log(`PM member:     ${pm.display_name} (id=${pm.id})`);
  console.log(`Normal member: ${member.display_name} (id=${member.id})`);

  // 3. Grant the PM the project_manager capability on that school.
  const [existingGrant] = await sql`
    select id from portal_capability_grants
    where member_id = ${pm.id} and school_id = ${school.id}
      and capability = 'project_manager' and revoked_at is null
  `;
  if (!existingGrant) {
    await sql`
      insert into portal_capability_grants (member_id, school_id, capability, granted_by)
      values (${pm.id}, ${school.id}, 'project_manager', ${pm.id})
    `;
    console.log("Granted project_manager capability.");
  } else {
    console.log("project_manager capability already present.");
  }

  // 4. Create a project (local scope) with the PM as president.
  let [project] = await sql`
    select id from portal_projects where title = 'Local Test Project' and school_id = ${school.id}
  `;
  if (!project) {
    [project] = await sql`
      insert into portal_projects (school_id, created_by, title, description, project_type, status, scope, president_id)
      values (${school.id}, ${pm.id}, 'Local Test Project', 'Seeded for local task-assignment testing', 'projet', 'in_progress', 'local', ${pm.id})
      returning id
    `;
    console.log(`Created project (id=${project.id})`);
  } else {
    console.log(`Using existing project (id=${project.id})`);
  }

  // 5. Create a team on that project, supervised by the PM.
  let [team] = await sql`
    select id from portal_project_teams where project_id = ${project.id} and name = 'Main Team'
  `;
  if (!team) {
    [team] = await sql`
      insert into portal_project_teams (project_id, name, supervisor_id, created_by)
      values (${project.id}, 'Main Team', ${pm.id}, ${pm.id})
      returning id
    `;
    console.log(`Created team (id=${team.id})`);
  } else {
    console.log(`Using existing team (id=${team.id})`);
  }

  // 6. Put the normal member on that team so they're a valid assignee.
  await sql`
    insert into portal_project_team_members (team_id, member_id, assigned_by)
    values (${team.id}, ${member.id}, ${pm.id})
    on conflict (team_id, member_id) do nothing
  `;
  console.log("Added Test Member to the team.");

  // 7. Mint a session for each member and print the raw cookie values.
  async function mintSession(memberId) {
    const rawToken = randomToken(32);
    const tokenHash = hashToken(rawToken);
    await sql`
      insert into portal_sessions (member_id, token_hash, expires_at, user_agent)
      values (${memberId}, ${tokenHash}, now() + interval '30 days', 'local-seed-script')
    `;
    return rawToken;
  }

  const pmToken = await mintSession(pm.id);
  const memberToken = await mintSession(member.id);

  console.log("\n=== Done. Paste these into your two browser windows/profiles. ===\n");
  console.log("Cookie name: ayc_portal_session\n");
  console.log(`PM (project manager) session token:\n  ${pmToken}\n`);
  console.log(`Normal member session token:\n  ${memberToken}\n`);
  console.log(
    "How to set it: open DevTools > Application (Chrome) or Storage (Firefox) > Cookies\n" +
    "> your localhost origin > add a cookie named 'ayc_portal_session' with the value above.\n" +
    "Use one regular window for the PM and one Incognito/private window for the member\n" +
    "(or two different browsers) so the cookies don't overwrite each other."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
