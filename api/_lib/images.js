// images.js
// Uploads a Discord attachment (photo/logo) to Cloudinary and returns a
// permanent URL to store in the club's data. Discord's own attachment
// URLs are not stable long-term, so we never save those directly.
//
// Env vars required (set in Vercel):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// No extra npm package needed — Cloudinary's "upload" REST endpoint takes
// a plain signed POST, which we build by hand below.

const crypto = require("crypto");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB safety cap (Discord's own limit is higher, but this keeps free-tier usage sane)

function buildSignature(paramsToSign, apiSecret) {
  // Cloudinary's signing rule: sort params alphabetically, join as
  // "key=value&key=value", append the API secret, then SHA-1 it.
  const sorted = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(sorted + apiSecret).digest("hex");
}

// kind: "bel" (member photo, 3:4, resized not cropped) |
//       "event" (event photo, 3:4, resized not cropped) |
//       "partner" (logo, 1:1, resized not cropped) |
//       "hero" (wide banner, no forced crop)
async function uploadDiscordAttachment(attachmentUrl, { kind = "bel", folder = "ayc-clubs" } = {}) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Le stockage d'images n'est pas configuré (variables Cloudinary manquantes). Contacte un·e admin technique."
    );
  }

  // Discord attachment URLs are publicly fetchable for a while after
  // posting, which is exactly the window we need — Cloudinary can fetch
  // directly from a remote URL, so we never have to download it ourselves
  // (keeps this function fast and avoids serverless payload limits).
  const headCheck = await fetch(attachmentUrl, { method: "HEAD" }).catch(() => null);
  if (headCheck) {
    const len = Number(headCheck.headers.get("content-length") || 0);
    if (len && len > MAX_IMAGE_BYTES) {
      throw new Error("L'image est trop grande (max 8 Mo). Essaie une image plus légère.");
    }
    const contentType = headCheck.headers.get("content-type") || "";
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error("Le fichier joint n'est pas reconnu comme une image.");
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${kind}_${crypto.randomBytes(4).toString("hex")}`;

  // Each image slot on the site has its own shape, matched here so the
  // upload is already the right crop and doesn't need editing later:
  //   bel     -> 3:4 portrait (member headshots)
  //   event   -> 3:4 portrait (event photos)
  //   partner -> 1:1 square (logos)
  //   hero    -> wide, uncropped (just size-capped)
  // Source photos are already delivered in the right shape (3:4 for
  // bel/event, 1:1 for partners), so this just resizes them — c_pad only
  // adds padding if an upload isn't exactly that ratio; it never crops.
  // (b_auto picks a matching padding color automatically when needed.)
  const transformation =
    kind === "bel" || kind === "event"
      ? "c_pad,b_auto,w_600,h_800,q_auto,f_auto" // 3:4, no crop
      : kind === "partner"
      ? "c_pad,b_auto,w_500,h_500,q_auto,f_auto" // 1:1, no crop
      : "c_limit,w_1600,q_auto,f_auto"; // hero: no forced crop

  const paramsToSign = {
    folder,
    public_id: publicId,
    timestamp,
    transformation,
  };
  const signature = buildSignature(paramsToSign, apiSecret);

  const form = new URLSearchParams();
  form.set("file", attachmentUrl);
  form.set("folder", folder);
  form.set("public_id", publicId);
  form.set("timestamp", String(timestamp));
  form.set("transformation", transformation);
  form.set("api_key", apiKey);
  form.set("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json = await res.json();
  if (!res.ok) {
    console.error("Cloudinary upload failed:", json);
    throw new Error(
      "L'envoi de l'image a échoué. Vérifie que le fichier est bien une image (jpg/png/webp) et réessaie."
    );
  }

  return json.secure_url; // permanent CDN URL to store in the club's JSON
}

module.exports = { uploadDiscordAttachment };
