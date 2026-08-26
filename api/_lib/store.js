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

async function listClubs() {
  const entries = await listDir("data/clubs");
  const clubs = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const slug = entry.name.replace(/\.json$/, "");
    const club = await getClub(slug);
    if (club) clubs.push(club);
  }
  return clubs;
}

async function saveClub(club, commitMessage) {
  const { sha } = await readJsonFile(clubPath(club.slug));
  await writeJsonFile(clubPath(club.slug), club, commitMessage, sha);
}

async function deleteClub(slug, commitMessage) {
  const { sha } = await readJsonFile(clubPath(slug));
  if (!sha) return; // already gone
  await deleteFile(clubPath(slug), commitMessage, sha);
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
  savePendingEdit,
  getPendingEdit,
  deletePendingEdit,
  listPendingEdits,
  readJsonFile,
  writeJsonFile,
};
