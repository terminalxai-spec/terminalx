const fs = require("node:fs");
const path = require("node:path");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload, null, 2));
}

function notFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function sendBuffer(res, statusCode, buffer, options = {}) {
  const filename = options.filename || "download.bin";
  res.writeHead(statusCode, {
    "content-type": options.contentType || "application/octet-stream",
    "content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`
  });
  res.end(buffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendStaticFile(res, filePath) {
  const normalizedPath = path.normalize(filePath);

  fs.readFile(normalizedPath, (error, content) => {
    if (error) {
      notFound(res);
      return;
    }

    const extension = path.extname(normalizedPath);
    res.writeHead(200, {
      "content-type": contentTypes[extension] || "application/octet-stream"
    });
    res.end(content);
  });
}

module.exports = {
  notFound,
  readJsonBody,
  sendBuffer,
  sendJson,
  sendStaticFile
};
