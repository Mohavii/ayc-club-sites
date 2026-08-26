// api/onboarding/upload-photo.js
// POST /api/onboarding/upload-photo
// Body: raw image bytes, Content-Type set to the image's mime type.
//
// The browser sends the file bytes straight to this function (a plain
// fetch(url, { method: "POST", body: file, headers: { "Content-Type": file.type } })
// — no client-side bundle/CDN dependency needed), and this function
// stores them in Vercel Blob and returns the public URL. Vercel's Node
// runtime buffers the request body into req.body as a Buffer for
// non-JSON/non-form content types, so no manual stream handling is
// needed here.
//
// Gated behind an in-progress signup (the signup-token cookie set right
// after Google sign-in) — this isn't an open upload endpoint.

const { put } = require("@vercel/blob");
const { getSignupIdentity } = require("../_lib/signup-tokens");

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — comfortably under Vercel's default serverless request-body limit
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function normalizeBody(req) {
  const raw = req.body;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw && raw.type === "Buffer" && Array.isArray(raw.data)) return Buffer.from(raw.data);
  if (typeof raw === "string" && raw.length > 0) return Buffer.from(raw, "binary");

  // Some local adapters expose a raw request stream instead of req.body.
  if (req && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.length > 0) return Buffer.concat(chunks);
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const identity = await getSignupIdentity(req);
    if (!identity) {
      res.status(401).json({ error: "Session d'inscription expirée." });
      return;
    }

    const contentType = req.headers["content-type"] || "";
    if (!ALLOWED_TYPES.includes(contentType)) {
      res.status(400).json({ error: "Format d'image non supporté (JPEG, PNG ou WEBP uniquement)." });
      return;
    }

    const body = await normalizeBody(req);
    if (!body || body.length === 0) {
      res.status(400).json({ error: "Fichier vide ou illisible." });
      return;
    }
    if (body.length > MAX_BYTES) {
      res.status(400).json({ error: "Image trop lourde (4 Mo max)." });
      return;
    }

    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const pathname = `avatars/${identity.google_id}-${Date.now()}.${ext}`;

    const blob = await put(pathname, body, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("upload-photo error:", err);
    res.status(500).json({ error: "Échec du téléversement." });
  }
};
