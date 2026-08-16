// api/interactions.js
// This is the single endpoint Discord calls for every slash command and
// every button click, once you set your app's "Interactions Endpoint URL"
// to https://<your-vercel-project>.vercel.app/api/interactions
//
// Deployed on Vercel, this file becomes a serverless function — no
// always-on process needed, matching the "serverless, don't babysit a
// server" hosting decision.

const { verifyKey } = require("discord-interactions");
const store = require("./_lib/store");
const { checkClubEditPermission, isNationalAdmin } = require("./_lib/permissions");
const { submitEdit, buildReviewMessage, postToReviewChannel } = require("./_lib/edits");
const { applyEdit } = require("./_lib/apply-edit");
const { slugify } = require("./_lib/slug");

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

// Vercel needs the raw request body (not pre-parsed) to verify Discord's
// signature, so we turn off the default body parser for this route.
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function ephemeral(content) {
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: 64 } };
}

function getOpt(options, name) {
  const opt = (options || []).find((o) => o.name === name);
  return opt ? opt.value : undefined;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const isValid = verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY);

  if (!isValid) {
    res.status(401).send("Bad request signature");
    return;
  }

  const interaction = JSON.parse(rawBody.toString("utf8"));

  if (interaction.type === InteractionType.PING) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  try {
    if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      const result = await handleAutocomplete(interaction);
      res.status(200).json(result);
      return;
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const result = await handleCommand(interaction);
      res.status(200).json(result);
      return;
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const result = await handleComponent(interaction);
      res.status(200).json(result);
      return;
    }

    res.status(400).send("Unhandled interaction type");
  } catch (err) {
    console.error(err);
    res.status(200).json(ephemeral(`❌ Une erreur est survenue : ${err.message}`));
  }
};

// ---------------- autocomplete (club: <autocomplete>) ----------------

async function handleAutocomplete(interaction) {
  const focused = (interaction.data.options || []).find((o) => o.focused) ||
    findFocusedNested(interaction.data.options);
  const query = (focused?.value || "").toLowerCase();

  const userId = interaction.member?.user?.id || interaction.user?.id;
  const admin = isNationalAdmin(interaction);

  const clubs = await store.listClubs();
  const visible = admin ? clubs : clubs.filter((c) => Array.isArray(c.officers) && c.officers.includes(userId));

  const choices = visible
    .filter((c) => c.name.toLowerCase().includes(query) || c.slug.includes(query))
    .slice(0, 25)
    .map((c) => ({ name: `${c.name} (${c.slug})`, value: c.slug }));

  return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
}

function findFocusedNested(options) {
  for (const o of options || []) {
    if (o.focused) return o;
    if (o.options) {
      const nested = findFocusedNested(o.options);
      if (nested) return nested;
    }
  }
  return null;
}

// ---------------- slash commands ----------------

async function handleCommand(interaction) {
  const data = interaction.data;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const userTag = interaction.member?.user?.username || interaction.user?.username || "inconnu";

  // Sub-command groups/names come nested: /club event add -> options[0].options[0]
  const top = data.options && data.options[0];
  const sub = top && top.options && top.options[0];

  const command = data.name; // "club"
  const group = top ? top.name : null; // "event" | "bel" | "partner" | "create" | "set-about" | ...
  const action = sub ? sub.name : null; // "add" | "remove" (only for grouped subcommands)
  const opts = sub ? sub.options : top ? top.options : [];

  if (command !== "club") return ephemeral("Commande inconnue.");

  switch (group) {
    case "create":
      return cmdCreate(opts, userId, userTag);
    case "list":
      return cmdList();
    case "set-about":
      return cmdSetSimpleField(opts, userId, userTag, "about", "text", "À propos");
    case "set-stats":
      return cmdSetStats(opts, userId, userTag);
    case "publish":
      return cmdPublish(opts, userId, userTag);
    case "event":
      return action === "add" ? cmdEventAdd(opts, userId, userTag) : cmdEventRemove(opts, userId, userTag);
    case "bel":
      return action === "add" ? cmdBelAdd(opts, userId, userTag) : cmdBelRemove(opts, userId, userTag);
    case "partner":
      return action === "add" ? cmdPartnerAdd(opts, userId, userTag) : cmdPartnerRemove(opts, userId, userTag);
    default:
      return ephemeral("Sous-commande inconnue.");
  }
}

async function requireClubAndPermission(interaction_userId, clubSlug, interactionForRoleCheck) {
  const club = await store.getClub(clubSlug);
  if (!club) return { error: ephemeral(`❌ Aucun club trouvé avec l'identifiant \`${clubSlug}\`.`) };
  const perm = checkClubEditPermission(interactionForRoleCheck, club);
  if (!perm.allowed) return { error: ephemeral(`❌ ${perm.reason}`) };
  return { club, isAdmin: perm.isAdmin };
}

// /club create name school city founded
async function cmdCreate(opts, userId, userTag) {
  const name = getOpt(opts, "name");
  const school = getOpt(opts, "school");
  const city = getOpt(opts, "city");
  const founded = getOpt(opts, "founded");
  if (!name || !city) return ephemeral("❌ Le nom et la ville sont obligatoires.");

  const slug = slugify(school || name);
  const existing = await store.getClub(slug);
  if (existing) return ephemeral(`❌ Un club existe déjà avec l'identifiant \`${slug}\`. Choisis un autre nom ou contacte un·e admin.`);

  const newClub = {
    slug,
    status: "draft",
    name,
    city,
    founded: founded ? Number(founded) : null,
    memberCount: 0,
    about: "",
    heroImage: null,
    officers: [userId],
    events: [],
    bel: [],
    partners: [],
  };

  const edit = await submitEdit({
    clubSlug: slug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "create",
    path: "*",
    newValue: newClub,
    label: `création du club "${name}"`,
  });
  await postToReviewChannel(buildReviewMessage(edit));

  return ephemeral(
    `✅ Demande de création envoyée pour **${name}** (identifiant : \`${slug}\`).\nElle attend l'approbation d'un·e admin national·e — la page ne sera visible qu'après \`/club publish\`.`
  );
}

async function cmdList() {
  const clubs = await store.listClubs();
  if (!clubs.length) return ephemeral("Aucun club enregistré pour le moment.");
  const lines = clubs.map((c) => `• **${c.name}** — \`${c.slug}\` — ${c.status === "live" ? "🟢 en ligne" : "🟡 brouillon"}`);
  return ephemeral(lines.join("\n"));
}

async function cmdSetStats(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const members = getOpt(opts, "members");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;
  if (members === undefined) return ephemeral("❌ Précise le nombre de membres avec `members:`.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: "memberCount",
    oldValue: club.memberCount,
    newValue: Number(members),
    label: "Nombre de membres actifs",
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Modification envoyée en révision pour **${club.name}**.`);
}

async function cmdSetSimpleField(opts, userId, userTag, fieldPath, optName, label) {
  const clubSlug = getOpt(opts, "club");
  const value = getOpt(opts, optName);
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;
  if (value === undefined) return ephemeral("❌ Le champ texte est obligatoire.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "update",
    path: fieldPath,
    oldValue: club[fieldPath],
    newValue: value,
    label,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Modification envoyée en révision pour **${club.name}**.`);
}

async function cmdPublish(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const club = await store.getClub(clubSlug);
  if (!club) return ephemeral(`❌ Aucun club (brouillon en attente ou publié) trouvé avec \`${clubSlug}\`. Si tu viens de faire \`/club create\`, attends d'abord l'approbation admin.`);
  if (club.status === "live") return ephemeral(`ℹ️ **${club.name}** est déjà en ligne.`);
  return ephemeral(
    `ℹ️ **${club.name}** est encore en brouillon en attente d'approbation. Un·e admin national·e doit approuver la création avant publication — vérifie le salon de révision.`
  );
}

async function cmdEventAdd(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const item = {
    id: "evt_" + Math.random().toString(36).slice(2, 8),
    title: getOpt(opts, "title"),
    date: getOpt(opts, "date"),
    location: getOpt(opts, "location"),
    description: getOpt(opts, "description"),
    axis: getOpt(opts, "axis"),
    image: null,
  };
  if (!item.title || !item.date) return ephemeral("❌ Le titre et la date sont obligatoires.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "events",
    newValue: item,
    label: `Nouvel événement : ${item.title}`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Événement envoyé en révision pour **${club.name}**.`);
}

async function cmdEventRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const eventId = getOpt(opts, "event");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "events",
    newValue: eventId,
    label: `Suppression d'un événement (id: ${eventId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

async function cmdBelAdd(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const item = {
    id: "bel_" + Math.random().toString(36).slice(2, 8),
    role: getOpt(opts, "role"),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    photo: null, // photo attachments handled as a documented follow-up step, see README
  };
  if (!item.role || !item.name) return ephemeral("❌ Le rôle et le nom sont obligatoires.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "bel",
    newValue: item,
    label: `Nouveau membre BEL : ${item.name} (${item.role})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Membre BEL envoyé en révision pour **${club.name}**.`);
}

async function cmdBelRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const memberId = getOpt(opts, "member");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "bel",
    newValue: memberId,
    label: `Suppression d'un membre BEL (id: ${memberId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

async function cmdPartnerAdd(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const item = {
    id: "ptn_" + Math.random().toString(36).slice(2, 8),
    name: getOpt(opts, "name"),
    description: getOpt(opts, "description"),
    logo: null,
  };
  if (!item.name) return ephemeral("❌ Le nom du partenaire est obligatoire.");

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "add",
    path: "partners",
    newValue: item,
    label: `Nouveau partenaire : ${item.name}`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Partenaire envoyé en révision pour **${club.name}**.`);
}

async function cmdPartnerRemove(opts, userId, userTag) {
  const clubSlug = getOpt(opts, "club");
  const partnerId = getOpt(opts, "partner");
  const { error, club } = await requireClubAndPermission(userId, clubSlug, { member: { user: { id: userId } } });
  if (error) return error;

  const edit = await submitEdit({
    clubSlug,
    submittedBy: userId,
    submittedByTag: userTag,
    type: "remove",
    path: "partners",
    newValue: partnerId,
    label: `Suppression d'un partenaire (id: ${partnerId})`,
  });
  await postToReviewChannel(buildReviewMessage(edit));
  return ephemeral(`✅ Suppression envoyée en révision pour **${club.name}**.`);
}

// ---------------- button clicks (Approve / Reject) ----------------

async function handleComponent(interaction) {
  const customId = interaction.data.custom_id; // "approve:<slug>:<editId>" | "reject:<slug>:<editId>"
  const [action, clubSlug, editId] = customId.split(":");

  if (!isNationalAdmin(interaction)) {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Seul·e un·e admin national·e peut approuver ou rejeter une modification.", flags: 64 },
    };
  }

  const { data: edit, sha } = await store.getPendingEdit(clubSlug, editId);
  if (!edit) {
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: "⚠️ Cette modification n'existe plus (déjà traitée ?).", components: [] },
    };
  }

  const reviewerId = interaction.member?.user?.id || interaction.user?.id;

  if (action === "approve") {
    const club = await applyEdit(edit);
    await store.deletePendingEdit(clubSlug, editId, sha, `approved by ${reviewerId}`);
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: `✅ **Approuvé** par <@${reviewerId}>\n${edit.label || edit.path} — **${club.name}**\n\n_Le site se met à jour automatiquement (1 à 2 minutes)._`,
        components: [],
      },
    };
  }

  if (action === "reject") {
    await store.deletePendingEdit(clubSlug, editId, sha, `rejected by ${reviewerId}`);
    return {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content: `❌ **Rejeté** par <@${reviewerId}>\n${edit.label || edit.path} — proposé par <@${edit.submittedBy}>`,
        components: [],
      },
    };
  }

  return ephemeral("Action inconnue.");
}
