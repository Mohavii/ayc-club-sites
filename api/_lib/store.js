// store.js
// A thin "database" layer that actually just reads/writes JSON files in
// this GitHub repo via the GitHub API. Every write is a git commit, which
// gives us a free audit trail (git history = who changed what, when) and
// automatically triggers the GitHub Action that rebuilds the website.
//
// Env vars required (set these in Vercel's project settings):
//   GITHUB_TOKEN   - a GitHub Personal Access Token with "repo" scope
//   GITHUB_OWNER   - your GitHub username or org, e.g. "ayc-tunisia"
//   GITHUB_REPO    - the repo name, e.g. "ayc-club-sites"
//   GITHUB_BRANCH  - usually "main"

const { Octokit } = require("@octokit/rest");
const { syncSchoolOnSave, syncSchoolOnDelete } = require("./schools-sync");
const { deprovisionClubDiscordResources } = require("./discord-provisioning");

function getClient() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

const OWNER = () => process.env.GITHUB_OWNER;
const REPO = () => process.env.GITHUB_REPO;
const BRANCH = () => process.env.GITHUB_BRANCH || "main";

// ---------- low-level file read/write ----------

async function readJsonFile(path) {
  const octokit = getClient();
  try {
    const res = await octokit.repos.getContent({
      owner: OWNER(),
      repo: REPO(),
      path,
      ref: BRANCH(),
    });
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return { data: JSON.parse(content), sha: res.data.sha };
  } catch (err) {
    if (err.status === 404) return { data: null, sha: null };
    throw err;
  }
}

async function writeJsonFile(path, data, message, existingSha) {
  const octokit = getClient();
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64");
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER(),
    repo: REPO(),
    path,
    message,
    content,
    branch: BRANCH(),
    sha: existingSha || undefined,
  });
}

async function deleteFile(path, message, sha) {
  const octokit = getClient();
  await octokit.repos.deleteFile({
    owner: OWNER(),
    repo: REPO(),
    path,
    message,
    branch: BRANCH(),
    sha,
  });
}

async function listDir(path) {
  const octokit = getClient();
  try {
    const res = await octokit.repos.getContent({
      owner: OWNER(),
      repo: REPO(),
      path,
      ref: BRANCH(),
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

// ---------- club records ----------

function clubPath(slug) {
  return `data/clubs/${slug}.json`;
}

async function getClub(slug) {
  const { data } = await readJsonFile(clubPath(slug));
  return data;
}

// Autocomplete fires on every keystroke and needs to answer well within
// Discord's ~3s interaction budget. Re-listing + re-fetching every club
// file from the GitHub API on each keystroke was slow enough (especially
// as the club count grows) to blow that budget and show as "Loading
// options failed" client-side — this short cache keeps repeated
// keystrokes during one typing burst fast, while still refreshing often
// enough that a just-created/deleted club shows up within a few seconds.
const LIST_CLUBS_CACHE_MS = 10_000;
let listClubsCache = null; // { at: number, promise: Promise<club[]> }

async function listClubs() {
  const now = Date.now();
  if (listClubsCache && now - listClubsCache.at < LIST_CLUBS_CACHE_MS) {
    return listClubsCache.promise;
  }
  const promise = (async () => {
    const entries = await listDir("data/clubs");
    const jsonEntries = entries.filter((entry) => entry.name.endsWith(".json"));
    // Fetch every club file in parallel instead of one-by-one — with N
    // clubs, sequential awaits meant N+1 round-trips before autocomplete
    // could even respond.
    const results = await Promise.all(
      jsonEntries.map((entry) => getClub(entry.name.replace(/\.json$/, "")))
    );
    return results.filter(Boolean);
  })();
  listClubsCache = { at: now, promise };
  // If the fetch fails, don't leave a rejected promise cached — the next
  // call should retry rather than keep re-throwing the same error for
  // LIST_CLUBS_CACHE_MS.
  promise.catch(() => {
    if (listClubsCache && listClubsCache.promise === promise) listClubsCache = null;
  });
  return promise;
}

// Clears the listClubs cache immediately — called after any write so a
// club that was just created/deleted/renamed shows up right away instead
// of waiting out the cache window.
function invalidateClubsCache() {
  listClubsCache = null;
}

async function saveClub(club, commitMessage) {
  const { sha } = await readJsonFile(clubPath(club.slug));
  await writeJsonFile(clubPath(club.slug), club, commitMessage, sha);
  invalidateClubsCache();
  // Keep the member portal's school list live-synced with this club.
  // See schools-sync.js — failures there are logged, never thrown, so
  // a portal/database hiccup can't break the Discord bot's own save.
  await syncSchoolOnSave(club);
}

async function deleteClub(slug, commitMessage) {
  const { data: club, sha } = await readJsonFile(clubPath(slug));
  if (!sha) return; // already gone

  // Tear down everything Discord-side (VPC role, category, channels)
  // BEFORE the club's JSON file is deleted — we need the club record's
  // vpcRoleId/categoryId/channelIds to know what to remove. Best-effort:
  // logged failures here never block the actual deletion below, so a
  // Discord hiccup can't leave a club stuck and undeletable.
  try {
    await deprovisionClubDiscordResources(club);
  } catch (err) {
    console.error(`Failed to deprovision Discord resources for ${slug}:`, err);
  }

  await deleteFile(clubPath(slug), commitMessage, sha);
  invalidateClubsCache();
  // Deactivates the portal school and deletes any member accounts tied
  // to it — a club being deleted here means it no longer exists at all.
  await syncSchoolOnDelete(slug);
}

// ---------- pending edits ----------

function pendingPath(slug, editId) {
  return `data/pending/${slug}/${editId}.json`;
}

async function savePendingEdit(edit) {
  await writeJsonFile(
    pendingPath(edit.clubSlug, edit.editId),
    edit,
    `Pending edit: ${edit.clubSlug} / ${edit.path} (by ${edit.submittedBy})`
  );
}

async function getPendingEdit(slug, editId) {
  const { data, sha } = await readJsonFile(pendingPath(slug, editId));
  return { data, sha };
}

async function deletePendingEdit(slug, editId, sha, reason) {
  await deleteFile(pendingPath(slug, editId), `Resolved pending edit: ${slug} / ${editId} (${reason})`, sha);
}

async function listPendingEdits(slug) {
  const entries = await listDir(`data/pending/${slug}`);
  const edits = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const editId = entry.name.replace(/\.json$/, "");
    const { data } = await getPendingEdit(slug, editId);
    if (data) edits.push(data);
  }
  return edits;
}

module.exports = {
  getClub,
  listClubs,
  saveClub,
  deleteClub,
  invalidateClubsCache,
  savePendingEdit,
  getPendingEdit,
  deletePendingEdit,
  listPendingEdits,
  readJsonFile,
  writeJsonFile,
};
