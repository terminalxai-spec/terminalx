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
assert.match(indexHtml, /data-page="workflows"/, "Workflows page is missing");
assert.match(indexHtml, /id="workflow-summary"/, "Workflow dashboard summary is missing");
assert.match(indexHtml, /id="bot-create-form"/, "Custom Bot Builder form is missing");
assert.match(indexHtml, /id="worker-activity-list"/, "Worker activity list is missing");
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
assert.match(indexHtml, /id="chat-stop-button"/, "Chat page must include a stop generation button");
assert.match(indexHtml, /id="new-chat-button"/, "Chat page must support new conversations");
assert.match(indexHtml, /id="rename-chat-button"/, "Chat page must support renaming conversations");
assert.match(indexHtml, /id="delete-chat-button"/, "Chat page must support deleting conversations");
assert.match(indexHtml, /id="chat-drop-zone"/, "Chat page must include drag/drop upload UI");
assert.match(indexHtml, /id="attachment-preview"/, "Chat page must preview attachments");
assert.match(indexHtml, /id="activity-feed"/, "Dashboard must include live activity feed");
assert.match(indexHtml, /id="toast-region"/, "Dashboard must include toast notifications");
assert.match(indexHtml, /id="task-drawer"/, "Tasks page must include a task detail drawer");
assert.match(indexHtml, /id="dashboard-alert"/, "Dashboard must include approval alert area");
assert.match(indexHtml, /id="file-search-input"/, "Files page must include search");
assert.match(indexHtml, /id="splash-screen"/, "PWA must include a branded loading splash");

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
assert.match(appJs, /\/api\/workflows/, "Dashboard must load workflows");
assert.match(appJs, /\/api\/bots/, "Dashboard must support custom bots");
assert.match(appJs, /\/api\/integrations/, "Dashboard must show integrations");
assert.match(appJs, /renderWorkflowDashboard/, "Dashboard must render workflow dashboard");
assert.match(appJs, /timelineForWorkflow/, "Dashboard must render workflow execution timelines");
assert.match(appJs, /\/api\/chat/, "Dashboard must send chat messages");
assert.match(appJs, /message-bubble/, "Dashboard must render chat bubbles");
assert.match(appJs, /renderMarkdown/, "Dashboard must render markdown");
assert.match(appJs, /data-copy-message/, "Assistant messages must expose copy controls");
assert.match(appJs, /data-regenerate-message/, "Assistant messages must expose regenerate controls");
assert.match(appJs, /streamAssistantMessage/, "Dashboard must provide progressive streaming UI");
assert.match(appJs, /stopGeneration/, "Dashboard must support stopping generation");
assert.match(appJs, /dragover/, "Dashboard must support drag/drop uploads");
assert.match(appJs, /showToast/, "Dashboard must show toast notifications");
assert.match(appJs, /renderActivityFeed/, "Dashboard must render agent activity");
assert.match(appJs, /renderTaskDrawer/, "Dashboard must render task details");
assert.match(appJs, /renderWorkflowStepper/, "Task cards must show workflow steps");
assert.match(appJs, /Action needed: You must approve file generation/, "Waiting approval tasks must explain the human action");
assert.match(appJs, /Approval needed from: You \/ Admin/, "Task drawer must say who needs to approve");
assert.match(appJs, /pending from You \/ Admin/, "Where-is-my-app panel must explain approval ownership");
assert.match(appJs, /Approval needed from/, "Approval cards must explain who approves");
assert.match(appJs, /Requested by/, "Approval cards must show the requesting agent");
assert.match(appJs, /Waiting for your approval on/, "Agent cards must show waiting approval work");
assert.match(appJs, /Where is my app\?/, "Task detail must explain where generated apps live");
assert.match(appJs, /conversationPreferences/, "Dashboard must support conversation sidebar state");
assert.match(appJs, /renderChatSelectors/, "Dashboard must populate chat file and task selectors");
assert.match(appJs, /summarizeSelectedFile/, "Dashboard must summarize selected files");
assert.match(appJs, /explainSelectedTask/, "Dashboard must explain selected tasks");
assert.match(appJs, /renderChatError/, "Dashboard must render chat errors");

const styles = fs.readFileSync(path.join(publicRoot, "styles.css"), "utf8");
assert.match(styles, /@media \(max-width: 760px\)/, "Dashboard must include mobile responsive styles");
assert.match(styles, /sidebar-collapsed/, "Sidebar must support collapsed state");
assert.match(styles, /task-drawer/, "Tasks must include drawer styling");
assert.match(styles, /toast-region/, "Toasts must include styling");
assert.match(styles, /chat-drop-zone/, "Drag/drop upload must include styling");
assert.match(styles, /markdown-body/, "Markdown content must include styling");

console.log("Frontend build validation passed.");
