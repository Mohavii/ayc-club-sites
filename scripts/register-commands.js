// register-commands.js
// Run this ONCE (and again any time you change a command's shape) to tell
// Discord which slash commands your bot supports:
//
//   node scripts/register-commands.js
//
// Needs these environment variables set in your terminal (see README):
//   DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID (your server's ID)

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // guild = server, registering per-server = instant updates

const AXIS_CHOICES = [
  { name: "Citoyenneté", value: "Citoyenneté" },
  { name: "Santé", value: "Santé" },
  { name: "Scolarité", value: "Scolarité" },
  { name: "Éducation formelle", value: "Éducation formelle" },
  { name: "Vie active", value: "Vie active" },
];

const clubAutocompleteOption = {
  type: 3, // STRING
  name: "club",
  description: "Le club concerné",
  required: true,
  autocomplete: true,
};

const commands = [
  {
    name: "club",
    description: "Gérer les pages des clubs locaux",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "create",
        description: "Proposer la création d'un nouveau club (attend approbation admin)",
        options: [
          { type: 3, name: "name", description: "Nom du club (ex: YOUTH CLUB Menzah 8)", required: true },
          { type: 3, name: "city", description: "Ville", required: true },
          { type: 3, name: "school", description: "Nom de l'établissement", required: false },
          { type: 4, name: "founded", description: "Année de fondation", required: false },
        ],
      },
      { type: 1, name: "list", description: "Lister tous les clubs et leur statut" },
      {
        type: 1,
        name: "publish",
        description: "Vérifier si un club en brouillon est prêt à être publié",
        options: [clubAutocompleteOption],
      },
      {
        type: 1,
        name: "set-about",
        description: "Modifier le texte de présentation du club",
        options: [clubAutocompleteOption, { type: 3, name: "text", description: "Nouveau texte", required: true }],
      },
      {
        type: 1,
        name: "set-stats",
        description: "Modifier le nombre de membres actifs",
        options: [clubAutocompleteOption, { type: 4, name: "members", description: "Nombre de membres actifs", required: true }],
      },
      {
        type: 1,
        name: "set-hero-image",
        description: "Changer l'image d'en-tête du club",
        options: [clubAutocompleteOption, { type: 11, name: "image", description: "Nouvelle image d'en-tête", required: true }],
      },
      {
        type: 2, // SUB_COMMAND_GROUP
        name: "event",
        description: "Gérer les événements du club",
        options: [
          {
            type: 1,
            name: "add",
            description: "Ajouter un événement",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "title", description: "Titre de l'événement", required: true },
              { type: 3, name: "date", description: "Date (AAAA-MM-JJ) — optionnel, peut être ajoutée plus tard", required: false },
              { type: 3, name: "location", description: "Lieu", required: false },
              { type: 3, name: "description", description: "Courte description", required: false },
              { type: 3, name: "axis", description: "Axe stratégique", required: false, choices: AXIS_CHOICES },
              { type: 11, name: "photo", description: "Photo de l'événement (format portrait)", required: false },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Retirer un événement",
            options: [clubAutocompleteOption, { type: 3, name: "event", description: "ID de l'événement (voir /club list détails)", required: true }],
          },
        ],
      },
      {
        type: 2,
        name: "bel",
        description: "Gérer le Bureau Exécutif Local",
        options: [
          {
            type: 1,
            name: "add",
            description: "Ajouter un membre du BEL",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "role", description: "Rôle (ex: Président du club)", required: true },
              { type: 3, name: "name", description: "Nom complet", required: true },
              { type: 3, name: "description", description: "Courte description du rôle", required: false },
              { type: 11, name: "photo", description: "Photo du membre (carrée de préférence)", required: false },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Retirer un membre du BEL",
            options: [clubAutocompleteOption, { type: 3, name: "member", description: "ID du membre", required: true }],
          },
        ],
      },
      {
        type: 2,
        name: "partner",
        description: "Gérer les partenaires du club",
        options: [
          {
            type: 1,
            name: "add",
            description: "Ajouter un partenaire",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "name", description: "Nom du partenaire", required: true },
              { type: 3, name: "description", description: "Nature du soutien", required: false },
              { type: 11, name: "logo", description: "Logo du partenaire (carré de préférence)", required: false },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Retirer un partenaire",
            options: [clubAutocompleteOption, { type: 3, name: "partner", description: "ID du partenaire", required: true }],
          },
        ],
      },
    ],
  },
];

async function main() {
  if (!APP_ID || !BOT_TOKEN || !GUILD_ID) {
    console.error("Missing DISCORD_APP_ID, DISCORD_BOT_TOKEN, or DISCORD_GUILD_ID environment variables.");
    process.exit(1);
  }

  const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    console.error("Failed to register commands:", res.status, await res.text());
    process.exit(1);
  }

  console.log("✅ Slash commands registered successfully.");
}

main();
