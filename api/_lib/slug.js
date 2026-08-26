// slug.js — turns "Lycée Pilote Menzah 8" into "lycee-pilote-menzah-8"

function slugify(str) {
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

module.exports = { slugify };
