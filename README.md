# AYC Club Sites — Discord bot + auto-updating website

This lets people manage each YOUTH CLUB's page **entirely from Discord**,
using slash commands like `/club event add`. No code, no logging into
anything to edit content. Everything is free to run.

You said you don't understand the technical side, and that's completely
fine — **you don't need to**. Everything below is copy-paste steps and
clicking buttons. It only needs to be done once. After that, your team
just types commands in Discord forever.

Budget yourself about **45–60 minutes**, done in one sitting if possible.

---

## What you're setting up, in plain terms

- A private storage space for club info (a free GitHub account — think of
  it as a filing cabinet with a "who changed what and when" log built in).
- A robot in your Discord server that listens for commands like
  `/club create`.
- A free website that automatically rebuilds itself a minute or two after
  someone's edit gets approved.
- A review step: local club leaders (VPCs) propose changes, and your
  national admins approve or reject them with one click in Discord.

---

## Step 1 — Create the GitHub repository (the "filing cabinet")

1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click the **+** in the top right → **New repository**.
3. Name it something like `ayc-club-sites`. Keep it **Public** (required for
   the free website hosting in Step 5). Click **Create repository**.
4. On your own computer, download this whole project folder I've given you,
   then upload every file into that new repository. The easiest way with
   no command line: on the repo's GitHub page, click **Add file → Upload
   files**, drag in everything, and click **Commit changes**.

## Step 2 — Turn on the free website (GitHub Pages)

1. In your new repository, click **Settings** (top menu).
2. In the left sidebar, click **Pages**.
3. Under "Build and deployment", set **Source** to **GitHub Actions**.
4. That's it — nothing to click "deploy," it happens automatically once
   Step 6 below runs for the first time.

## Step 3 — Create a GitHub access key (lets the bot write files)

1. Click your profile picture (top right) → **Settings**.
2. Left sidebar, scroll down → **Developer settings**.
3. **Personal access tokens** → **Tokens (classic)** → **Generate new token
   (classic)**.
4. Name it `ayc-bot`. Set expiration to **No expiration** (or 1 year, and
   set a calendar reminder to renew it).
5. Check the box next to **repo** (this grants read/write to your
   repositories).
6. Click **Generate token** and **copy it somewhere safe immediately** —
   GitHub only shows it once. This is `GITHUB_TOKEN` in Step 5.

## Step 4 — Create the Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications).
2. Click **New Application**, name it (e.g. "AYC Club Bot"), accept terms.
3. Left sidebar → **General Information**. Copy the **Application ID**
   (this is `DISCORD_APP_ID`) and **Public Key** (this is
   `DISCORD_PUBLIC_KEY`) — paste both somewhere safe.
4. Left sidebar → **Bot**. Click **Reset Token** → copy it (this is
   `DISCORD_BOT_TOKEN`) — paste it somewhere safe. Keep this page open.
5. Left sidebar → **OAuth2** → **URL Generator**. Under "Scopes" check
   **bot** and **applications.commands**. Under "Bot Permissions" check
   **Send Messages** and **Use Slash Commands**. Copy the generated URL
   at the bottom, open it in a new tab, and add the bot to your Discord
   server.
6. In Discord, go to your server → right-click the channel you want to use
   for reviewing pending edits (or create a new private channel called
   `#pending-edits` visible only to national admins) → **Copy Channel ID**
   (you may need to enable Developer Mode first: Discord Settings →
   Advanced → Developer Mode). This is `REVIEW_CHANNEL_ID`.
7. Right-click your server's national-admin role → **Copy Role ID**. This
   is `NATIONAL_ADMIN_ROLE_ID`.
8. Right-click your server icon → **Copy Server ID**. This is
   `DISCORD_GUILD_ID`.

## Step 5 — Deploy the bot (Vercel, free)

1. Go to [vercel.com](https://vercel.com) and sign up using your GitHub
   account (this links them automatically).
2. Click **Add New → Project**, choose your `ayc-club-sites` repository,
   click **Import**.
3. Before deploying, open **Environment Variables** and add each of these
   (values you collected above):

   | Name | Value |
   |---|---|
   | `DISCORD_PUBLIC_KEY` | from Step 4.3 |
   | `DISCORD_BOT_TOKEN` | from Step 4.4 |
   | `GITHUB_TOKEN` | from Step 3.6 |
   | `GITHUB_OWNER` | your GitHub username |
   | `GITHUB_REPO` | `ayc-club-sites` |
   | `GITHUB_BRANCH` | `main` |
   | `REVIEW_CHANNEL_ID` | from Step 4.6 |
   | `NATIONAL_ADMIN_ROLE_ID` | from Step 4.7 |

4. Click **Deploy**. When it finishes, copy the project URL Vercel gives
   you (looks like `https://ayc-club-sites.vercel.app`).
5. Back in the Discord Developer Portal (Step 4), left sidebar →
   **General Information** → find **Interactions Endpoint URL** → paste in
   `https://ayc-club-sites.vercel.app/api/interactions` and **Save**.
   Discord will test the connection immediately — if it fails, double
   check `DISCORD_PUBLIC_KEY` was entered correctly in Vercel and
   redeploy.

## Step 6 — Register the slash commands (one-time)

This tells Discord what `/club create`, `/club event add`, etc. actually
look like. You need a computer with
[Node.js](https://nodejs.org) installed (the free "LTS" version — a
5-minute install if you don't have it).

1. Open a terminal (on Windows: search "Command Prompt"; on Mac: search
   "Terminal") in this project folder.
2. Run:
   ```
   npm install
   ```
3. Set your credentials (replace the placeholder values, keep the quotes):

   **Mac/Linux:**
   ```
   export DISCORD_APP_ID="your app id"
   export DISCORD_BOT_TOKEN="your bot token"
   export DISCORD_GUILD_ID="your server id"
   ```
   **Windows (Command Prompt):**
   ```
   set DISCORD_APP_ID=your app id
   set DISCORD_BOT_TOKEN=your bot token
   set DISCORD_GUILD_ID=your server id
   ```
4. Run:
   ```
   node scripts/register-commands.js
   ```
   You should see `✅ Slash commands registered successfully.` Commands
   appear in Discord within a few seconds.

## Step 7 — Try it

In your Discord server, type `/club create` and fill in a test club. Check
your `#pending-edits` channel — you (or another national admin) should see
a message with **Approve** / **Reject** buttons. Click **Approve**. Wait
about a minute, then visit:

```
https://<your-github-username>.github.io/ayc-club-sites/clubs/<slug>/
```

You should see the club's live page, styled exactly like the national
site.

---

## Everyday use, once this is all set up

- **National admins**: run any `/club ...` command for any club, or watch
  the review channel and click Approve/Reject on changes VPCs submit.
- **Local officers (VPCs)**: once a national admin has added their Discord
  user ID to a club's officer list (currently done by an admin editing
  that club's create step, or asking Claude/a developer to add a quick
  `/club add-officer` command if you want that self-serve later), they can
  run the same `/club ...` commands, but only for their own club, and
  everything they submit needs admin approval before it goes live.
- **Delay after approval**: about 1–2 minutes between clicking Approve and
  the public page updating. This is normal — it's the free website
  rebuilding itself.

## If something breaks

- **Interactions Endpoint URL fails to save in Discord**: usually means
  `DISCORD_PUBLIC_KEY` is wrong in Vercel, or the Vercel deployment
  failed — check the Vercel dashboard's "Deployments" tab for errors.
- **Commands don't show up in Discord**: re-run Step 6. Per-server
  commands (which this uses) show up almost instantly; if not, try
  restarting Discord.
- **Approve button says an error occurred**: check the Vercel dashboard →
  your project → **Logs** for the actual error message — it will usually
  say plainly what's missing (commonly an expired `GITHUB_TOKEN`).
- **A club page didn't update after approval**: check the **Actions** tab
  in your GitHub repository — it shows whether the rebuild succeeded or
  failed, and why.

## What "free" actually means here, honestly

Every service used (GitHub, GitHub Pages, Vercel, this bot) has a free
tier that comfortably covers a national federation of school clubs. If AYC
grows into hundreds of very actively-edited clubs with lots of photos,
you may eventually bump into free-tier limits (mainly image storage) —
that's a "nice problem to have" and can be solved later without rebuilding
anything.
