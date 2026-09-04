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
  { key: "control_room", name: "control-room", noWebhook: true },
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
// Also returns categoryId and channelIds (every channel created under
// that category) so the whole thing can be torn down later if the club
// is deleted — see deprovisionClubDiscordResources below.
async function provisionClubChannels(slug, vpcRoleId) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const adminRoleId = process.env.NATIONAL_ADMIN_ROLE_ID;
  const botUserId = process.env.DISCORD_APP_ID; // a bot's user ID is the same as its application ID
  if (!guildId || !vpcRoleId) return {};

  // Critical: @everyone denies VIEW_CHANNEL below, and the bot is a
  // member of @everyone too — without an explicit allow for the bot
  // itself, Discord silently blocks the bot from managing (or even
  // seeing) the very category/channels it just created, which is what
  // caused "403 Missing Permissions" even with Manage Channels granted.
  const everyoneDeny = { id: guildId, type: 0, deny: "1024" }; // VIEW_CHANNEL denied for @everyone
  const vpcAllow = { id: vpcRoleId, type: 0, allow: "1024" }; // VIEW_CHANNEL allowed for this club's VPC role
  const permissionOverwrites = [everyoneDeny, vpcAllow];
  if (adminRoleId) permissionOverwrites.push({ id: adminRoleId, type: 0, allow: "1024" });
  if (botUserId) permissionOverwrites.push({ id: botUserId, type: 1, allow: "1024" }); // type 1 = member overwrite, for the bot itself

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
  const channelIds = [];
  let controlRoomChannelId = null;
  for (const def of CHANNEL_DEFS) {
    try {
      const channel = await discordRequest("POST", `/guilds/${guildId}/channels`, {
        name: `${def.name}-${slug}`,
        type: 0, // GUILD_TEXT
        parent_id: category.id,
        permission_overwrites: permissionOverwrites,
      });
      channelIds.push(channel.id);
      if (def.noWebhook) {
        controlRoomChannelId = channel.id;
        continue;
      }
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
  return { formWebhooks, controlRoomChannelId, categoryId: category.id, channelIds };
}

// Full provisioning flow for a newly-approved club. Never throws — club
// creation must succeed even if Discord-side setup partially or fully
// fails (e.g. bot not yet re-authorized with the new permissions).
async function provisionClubDiscordResources(slug, clubName) {
  const vpcRoleId = await createClubRole(slug);
  if (!vpcRoleId) {
    return { vpcRoleId: null, formWebhooks: {}, controlRoomChannelId: null, categoryId: null, channelIds: [] };
  }
  const { formWebhooks, controlRoomChannelId, categoryId, channelIds } = await provisionClubChannels(slug, vpcRoleId);

  if (controlRoomChannelId) {
    try {
      await discordRequest("POST", `/channels/${controlRoomChannelId}/messages`, {
        embeds: [
          {
            title: "🎛️ Bienvenue dans votre salle de contrôle",
            description:
              "Toutes les commandes `/club ...` fonctionnent ici (et partout ailleurs). " +
              "Pour construire vos formulaires facilement, tape `/form` et choisis un formulaire dans le menu.",
            color: 0x273263,
          },
        ],
      });
      // The actual button-driven control panel — kept as its own message
      // so it can be freely clicked/updated without disturbing the
      // welcome text above it.
      await discordRequest("POST", `/channels/${controlRoomChannelId}/messages`, {
        embeds: [
          {
            title: `🎛️ Panneau de contrôle — ${clubName}`,
            description: "Choisis une section à gérer.",
            color: 0x273263,
          },
        ],
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: "Événements", custom_id: `panel:events:${slug}` },
              { type: 2, style: 1, label: "BEL", custom_id: `panel:bel:${slug}` },
              { type: 2, style: 1, label: "Partenaires", custom_id: `panel:partners:${slug}` },
            ],
          },
          {
            type: 1,
            components: [{ type: 2, style: 1, label: "Infos du club", custom_id: `panel:info:${slug}` }],
          },
        ],
      });
    } catch (err) {
      console.error(`Failed to post welcome/panel message for ${slug}:`, err.message);
    }
  }

  return { vpcRoleId, formWebhooks, controlRoomChannelId, categoryId, channelIds: channelIds || [] };
}

// Full teardown for a club that's being deleted entirely: removes every
// text channel created for it, the category that held them, and its VPC
// role. Best-effort and never throws — club deletion (the GitHub file
// removal) must succeed even if Discord cleanup partially fails (e.g.
// something was already manually deleted, or the bot briefly lacks
// permission). Each resource is attempted independently so one failure
// doesn't block the others.
async function deprovisionClubDiscordResources(club) {
  if (!club) return;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;

  const channelIds = Array.isArray(club.channelIds) ? club.channelIds : [];
  // Fall back to the one channel id older club records might still have
  // if they were provisioned before channelIds existed.
  if (!channelIds.length && club.controlRoomChannelId) channelIds.push(club.controlRoomChannelId);

  for (const channelId of channelIds) {
    try {
      await discordRequest("DELETE", `/channels/${channelId}`);
    } catch (err) {
      console.error(`Failed to delete channel ${channelId} for ${club.slug}:`, err.message);
    }
  }

  if (club.categoryId) {
    try {
      await discordRequest("DELETE", `/channels/${club.categoryId}`);
    } catch (err) {
      console.error(`Failed to delete category ${club.categoryId} for ${club.slug}:`, err.message);
    }
  }

  if (club.vpcRoleId) {
    try {
      await discordRequest("DELETE", `/guilds/${guildId}/roles/${club.vpcRoleId}`);
    } catch (err) {
      console.error(`Failed to delete role ${club.vpcRoleId} for ${club.slug}:`, err.message);
    }
  }
}

module.exports = { provisionClubDiscordResources, deprovisionClubDiscordResources };
