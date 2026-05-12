const crypto = require("node:crypto");

const sessionCookieName = "terminalx_session";
const passwordIterations = 210000;
const passwordKeyLength = 32;
const passwordDigest = "sha256";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(String(password || ""), salt, passwordIterations, passwordKeyLength, passwordDigest)
    .toString("hex");
  return `pbkdf2$${passwordIterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, iterations, salt, expected] = String(storedHash || "").split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !expected) {
    return false;
  }
  const actual = crypto
    .pbkdf2Sync(String(password || ""), salt, Number(iterations), passwordKeyLength, passwordDigest)
    .toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function sessionSecret() {
  return process.env.SESSION_SECRET || "development-session-secret-change-me";
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSessionToken(token) {
  return crypto.createHmac("sha256", sessionSecret()).update(String(token || "")).digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function readSessionToken(req) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return parseCookies(req)[sessionCookieName] || "";
}

function sessionCookie(token, maxAgeSeconds = 60 * 60 * 24 * 7) {
  const secure = process.env.AUTH_COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function safeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || user.display_name || "",
    role: user.role || "operator",
    roles: user.roles || [],
    permissions: user.permissions || [],
    createdAt: user.createdAt || user.created_at
  };
}

function authRequired() {
  if (process.env.NODE_ENV === "test" && process.env.AUTH_REQUIRED !== "true") {
    return false;
  }
  return process.env.AUTH_REQUIRED !== "false";
}

module.exports = {
  authRequired,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  readSessionToken,
  safeUser,
  sessionCookie,
  verifyPassword
};
