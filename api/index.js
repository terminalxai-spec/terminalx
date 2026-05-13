const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const publicRoot = path.resolve(__dirname, "../apps/dashboard/public");

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function sendStatic(req, res, pathname) {
  const relativePath = pathname === "/" || pathname === "/dashboard" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicRoot, relativePath);
  if (!filePath.startsWith(publicRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  };
  res.statusCode = 200;
  res.setHeader("content-type", contentTypes[ext] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
  return true;
}

module.exports = function terminalxVercelHandler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "terminalx.local"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      name: process.env.TERMINALX_APP_NAME || "TerminalX",
      environment: process.env.TERMINALX_ENV || "production",
      runtimeMode: process.env.TERMINALX_RUNTIME_MODE || "ONLINE_MODE",
      databaseProvider: process.env.DATABASE_PROVIDER || "unset",
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/") && sendStatic(req, res, url.pathname)) {
    return;
  }

  try {
    const { handleRequest } = require("../services/api/src/server");
    return handleRequest(req, res);
  } catch (error) {
    return sendJson(res, 500, {
      error: "terminalx_startup_failed",
      message: error.message,
      required: [
        "DATABASE_PROVIDER=postgres",
        "DATABASE_URL",
        "SESSION_SECRET",
        "ADMIN_EMAIL",
        "ADMIN_PASSWORD"
      ]
    });
  }
};
