// discord-provisioning.js
// Runs once, right when a club is approved and goes live: creates the
// club's Discord role, a private category with 4 channels (one per
// form), and a webhook per channel so form submissions can post directly
// into Discord.
//
// Requires the bot to have been re-invited with these permissions:
// Manage Roles, Manage Channels, Manage Webhooks (in addition to the
// original bot + applications.commands scopes). If the bot lacks these,
// every call below fails gracefully — club creation still succeeds, it
// just won't have Discord channels/webhooks (falls back to the JSON-only
// submission storage already built into api/submit-form.js).

const DISCORD_API = "https://discord.com/api/v10";

function authHeaders() {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function discordRequest(method, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${method} ${path} failed: ${res.status} ${text}`);
  }
  // Some Discord endpoints (like delete) return no body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Creates the "VPC - <SLUG>" role for a club. Returns the role id, or
// null if creation failed (e.g. missing permission) — caller should
// treat null as "skip the rest of provisioning, not a hard failure."
async function createClubRole(slug) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.error(
      "Cannot provision Discord role/channels: DISCORD_GUILD_ID is not set in Vercel's environment variables."
    );
    return null;
  }
  try {
    const role = await discordRequest("POST", `/guilds/${guildId}/roles`, {
      name: `VPC - ${slug.toUpperCase()}`,
      mentionable: true,
      hoist: false,
    });
    return role.id;
  } catch (err) {
    console.error(`Failed to create role for ${slug}:`, err.message);
    return null;
  }
}

const CHANNEL_DEFS = [
  { key: "join", name: "candidatures" },
  { key: "team_communication", name: "candidatures-communication" },
  { key: "team_logistique", name: "candidatures-logistique" },
  { key: "team_sponsoring", name: "candidatures-sponsoring" },
];

// Creates a private category "Candidatures - <SLUG>" with 4 text channels
// inside, visible only to the club's VPC role and the national admin
// role. Creates one webhook per channel. Returns { formWebhooks } mapping
// form id -> webhook URL, or {} if anything failed partway (partial
// provisioning is treated as "not ready" rather than left half-built —
// caller stores whatever succeeded so submissions still work per-form).
async function provisionClubChannels(slug, vpcRoleId) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const adminRoleId = process.env.NATIONAL_ADMIN_ROLE_ID;
  if (!guildId || !vpcRoleId) return {};

  const everyoneDeny = { id: guildId, type: 0, deny: "1024" }; // VIEW_CHANNEL denied for @everyone
  const vpcAllow = { id: vpcRoleId, type: 0, allow: "1024" }; // VIEW_CHANNEL allowed for this club's VPC role
  const permissionOverwrites = [everyoneDeny, vpcAllow];
  if (adminRoleId) permissionOverwrites.push({ id: adminRoleId, type: 0, allow: "1024" });

  let category;
  try {
    category = await discordRequest("POST", `/guilds/${guildId}/channels`, {
      name: `Candidatures - ${slug.toUpperCase()}`,
      type: 4, // GUILD_CATEGORY
      permission_overwrites: permissionOverwrites,
    });
  } catch (err) {
    console.error(`Failed to create category for ${slug}:`, err.message);
    return {};
  }

  const formWebhooks = {};
  for (const def of CHANNEL_DEFS) {
    try {
      const channel = await discordRequest("POST", `/guilds/${guildId}/channels`, {
        name: `${def.name}-${slug}`,
        type: 0, // GUILD_TEXT
        parent_id: category.id,
        permission_overwrites: permissionOverwrites,
      });
      const webhook = await discordRequest("POST", `/channels/${channel.id}/webhooks`, {
        name: `Candidatures ${def.key}`,
      });
      formWebhooks[def.key] = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
    } catch (err) {
      console.error(`Failed to create channel/webhook for ${slug}/${def.key}:`, err.message);
      // Continue with the other channels rather than aborting entirely —
      // partial provisioning is better than none.
    }
  }
  return formWebhooks;
}

// Full provisioning flow for a newly-approved club. Never throws — club
// creation must succeed even if Discord-side setup partially or fully
// fails (e.g. bot not yet re-authorized with the new permissions).
async function provisionClubDiscordResources(slug) {
  const vpcRoleId = await createClubRole(slug);
  if (!vpcRoleId) {
    return { vpcRoleId: null, formWebhooks: {} };
  }
  const formWebhooks = await provisionClubChannels(slug, vpcRoleId);
  return { vpcRoleId, formWebhooks };
}

module.exports = { provisionClubDiscordResources };
