// cookies.js — minimal cookie parse/serialize, no extra dependency needed.

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

// Appends a Set-Cookie header without clobbering any already set on this
// response (res.setHeader would overwrite; we always want an array).
function appendSetCookie(res, cookieString) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", [cookieString]);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieString]);
  } else {
    res.setHeader("Set-Cookie", [existing, cookieString]);
  }
}

function serializeCookie(name, value, { maxAgeSeconds, httpOnly = true, path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${path}`);
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (httpOnly) parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name) {
  return serializeCookie(name, "", { maxAgeSeconds: 0 });
}

module.exports = { parseCookies, appendSetCookie, serializeCookie, clearCookie };
