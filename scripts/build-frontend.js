const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicRoot = path.resolve(__dirname, "../apps/dashboard/public");
const vercelPublicRoot = path.resolve(__dirname, "../public");
const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "sw.js",
  "icons/icon.svg"
];

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

for (const file of requiredFiles) {
  const fullPath = path.join(publicRoot, file);
  assert.ok(fs.existsSync(fullPath), `Missing frontend asset: ${file}`);
}

copyDirectory(publicRoot, vercelPublicRoot);

const indexHtml = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
assert.match(indexHtml, /<meta name="viewport"/, "Dashboard must include mobile viewport metadata");
assert.match(indexHtml, /rel="manifest"/, "Dashboard must link the PWA manifest");
assert.match(indexHtml, /id="login-form"/, "Dashboard must include a login form");
assert.match(indexHtml, /id="logout-button"/, "Dashboard must include a logout button");
assert.match(indexHtml, /data-page="command-center"/, "Command Center page is missing");
assert.match(indexHtml, /data-page="chat"/, "Chat page is missing");
assert.match(indexHtml, /data-page-link="chat"/, "Chat sidebar link is missing");
assert.match(indexHtml, /data-page="agents"/, "Agents page is missing");
assert.match(indexHtml, /data-page="tasks"/, "Tasks page is missing");
assert.match(indexHtml, /data-page="approvals"/, "Approval Queue page is missing");
assert.match(indexHtml, /data-page="files"/, "Files page is missing");
assert.match(indexHtml, /data-page="settings"/, "Settings page is missing");
assert.match(indexHtml, /id="chat-form"/, "Chat page must include a message form");
assert.match(indexHtml, /id="chat-messages"/, "Chat page must include a message list");
assert.match(indexHtml, /id="chat-file-selector"/, "Chat page must support file selection");
assert.match(indexHtml, /id="chat-task-selector"/, "Chat page must support task selection");
assert.match(indexHtml, /id="chat-summarize-file-button"/, "Chat page must summarize selected files");
assert.match(indexHtml, /id="chat-explain-task-button"/, "Chat page must explain selected tasks");
assert.match(indexHtml, /id="chat-create-task-button"/, "Chat page must support CEO task suggestions");
assert.match(indexHtml, /id="chat-typing-indicator"/, "Chat page must include a typing indicator");

const manifest = JSON.parse(fs.readFileSync(path.join(publicRoot, "manifest.webmanifest"), "utf8"));
assert.equal(manifest.name, "TerminalX Agent OS");
assert.equal(manifest.short_name, "TerminalX");
assert.equal(manifest.display, "standalone");
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, "PWA manifest needs at least one icon");

const appJs = fs.readFileSync(path.join(publicRoot, "app.js"), "utf8");
assert.match(appJs, /serviceWorker/, "Dashboard must register the service worker");
assert.match(appJs, /\/api\/config\/runtime/, "Dashboard must show runtime mode");
assert.match(appJs, /\/api\/auth\/login/, "Dashboard must call the login endpoint");
assert.match(appJs, /\/api\/auth\/me/, "Dashboard must check the current session");
assert.match(appJs, /currentPermissions/, "Dashboard must track RBAC permissions");
assert.match(appJs, /tasks:create/, "Dashboard must gate task creation by permission");
assert.match(appJs, /files:delete/, "Dashboard must gate file deletion by permission");
assert.match(appJs, /chat:use/, "Dashboard must gate chat by permission");
assert.match(appJs, /agents:execute/, "Dashboard must gate CEO task suggestions by permission");
assert.match(appJs, /\/api\/chat\/history/, "Dashboard must load chat history");
assert.match(appJs, /\/api\/chat/, "Dashboard must send chat messages");
assert.match(appJs, /message-bubble/, "Dashboard must render chat bubbles");
assert.match(appJs, /renderChatSelectors/, "Dashboard must populate chat file and task selectors");
assert.match(appJs, /summarizeSelectedFile/, "Dashboard must summarize selected files");
assert.match(appJs, /explainSelectedTask/, "Dashboard must explain selected tasks");
assert.match(appJs, /renderChatError/, "Dashboard must render chat errors");

console.log("Frontend build validation passed.");
