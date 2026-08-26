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

// Must match FORM_IDS / FORM_LABELS in api/interactions.js exactly —
// these are the 4 forms every club has: general join + 3 team-specific.
const FORM_CHOICES = [
  { name: "Rejoindre le club", value: "join" },
  { name: "Équipe Communication", value: "team_communication" },
  { name: "Équipe Logistique", value: "team_logistique" },
  { name: "Équipe Sponsoring", value: "team_sponsoring" },
];

// Must match FIELD_TYPE_LABELS in api/interactions.js exactly.
const FIELD_TYPE_CHOICES = [
  { name: "Texte court", value: "short_text" },
  { name: "Date", value: "date" },
  { name: "Case à cocher", value: "checkbox" },
  { name: "Lien Google Drive", value: "drive_link" },
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
        name: "delete",
        description: "Supprimer définitivement un club (admin uniquement, action irréversible)",
        options: [
          clubAutocompleteOption,
          { type: 3, name: "confirm", description: "Retape exactement le nom du club pour confirmer", required: true },
        ],
      },
      {
        type: 1,
        name: "set-logo",
        description: "Changer le logo du club (affiché en haut à gauche de la page)",
        options: [clubAutocompleteOption, { type: 11, name: "image", description: "Nouveau logo", required: true }],
      },
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
        type: 1,
        name: "remove-hero-image",
        description: "Retirer l'image d'en-tête du club",
        options: [clubAutocompleteOption],
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
            options: [clubAutocompleteOption, { type: 3, name: "event", description: "Choisis l'événement à retirer", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "remove-photo",
            description: "Retirer uniquement la photo d'un événement (garde l'événement)",
            options: [clubAutocompleteOption, { type: 3, name: "event", description: "Choisis l'événement", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "set-photo",
            description: "Ajouter ou remplacer la photo d'un événement existant",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "event", description: "Choisis l'événement", required: true, autocomplete: true },
              { type: 11, name: "photo", description: "Photo de l'événement (format portrait)", required: true },
            ],
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
              { type: 3, name: "role", description: "Rôle au sein du BEL", required: true, choices: [
                { name: "Président", value: "Président" },
                { name: "Trésorier", value: "Trésorier" },
                { name: "Secrétaire", value: "Secrétaire" },
                { name: "Vice-Président Internes", value: "Vice-Président Internes" },
                { name: "Vice-Président Externes", value: "Vice-Président Externes" },
                { name: "Vice-Président Communication", value: "Vice-Président Communication" },
              ] },
              { type: 3, name: "name", description: "Nom complet", required: true },
              { type: 3, name: "description", description: "Courte description du rôle", required: false },
              { type: 11, name: "photo", description: "Photo du membre (carrée de préférence)", required: false },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Retirer un membre du BEL",
            options: [clubAutocompleteOption, { type: 3, name: "member", description: "Choisis le membre à retirer", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "remove-photo",
            description: "Retirer uniquement la photo d'un membre (garde le membre)",
            options: [clubAutocompleteOption, { type: 3, name: "member", description: "Choisis le membre", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "set-photo",
            description: "Ajouter ou remplacer la photo d'un membre existant",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "member", description: "Choisis le membre", required: true, autocomplete: true },
              { type: 11, name: "photo", description: "Photo du membre (format portrait)", required: true },
            ],
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
            options: [clubAutocompleteOption, { type: 3, name: "partner", description: "Choisis le partenaire à retirer", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "remove-logo",
            description: "Retirer uniquement le logo d'un partenaire (garde le partenaire)",
            options: [clubAutocompleteOption, { type: 3, name: "partner", description: "Choisis le partenaire", required: true, autocomplete: true }],
          },
          {
            type: 1,
            name: "set-logo",
            description: "Ajouter ou remplacer le logo d'un partenaire existant",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "partner", description: "Choisis le partenaire", required: true, autocomplete: true },
              { type: 11, name: "logo", description: "Logo du partenaire (carré de préférence)", required: true },
            ],
          },
        ],
      },
      {
        type: 2,
        name: "form",
        description: "Gérer les formulaires du club (adhésion et équipes)",
        options: [
          {
            type: 1,
            name: "add-field",
            description: "Ajouter une question à un formulaire",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "form", description: "Quel formulaire", required: true, choices: FORM_CHOICES },
              { type: 3, name: "type", description: "Type de question", required: true, choices: FIELD_TYPE_CHOICES },
              { type: 3, name: "label", description: "Texte de la question", required: true },
              { type: 5, name: "required", description: "Réponse obligatoire ?", required: true },
            ],
          },
          {
            type: 1,
            name: "remove-field",
            description: "Retirer une question d'un formulaire",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "form", description: "Quel formulaire", required: true, choices: FORM_CHOICES },
              { type: 3, name: "field", description: "Quelle question", required: true, autocomplete: true },
            ],
          },
          {
            type: 1,
            name: "toggle",
            description: "Activer ou désactiver un formulaire",
            options: [
              clubAutocompleteOption,
              { type: 3, name: "form", description: "Quel formulaire", required: true, choices: FORM_CHOICES },
              { type: 5, name: "enabled", description: "Activer ?", required: true },
            ],
          },
          {
            type: 1,
            name: "list",
            description: "Voir tous les formulaires d'un club et leurs questions",
            options: [clubAutocompleteOption],
          },
        ],
      },
    ],
  },
  {
    name: "form",
    description: "Ouvrir le constructeur de formulaires (interface avec boutons)",
    options: [clubAutocompleteOption],
  },
  {
    name: "panel",
    description: "Ouvrir le panneau de contrôle du club (interface avec boutons)",
    options: [clubAutocompleteOption],
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
