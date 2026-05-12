const fs = require("node:fs");
const path = require("node:path");

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  "__pycache__"
]);

function fileExists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function readJsonIfExists(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function hasMatchingFile(root, matcher, limit = 2000) {
  let visited = 0;

  function walk(directory) {
    if (visited > limit) {
      return false;
    }

    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && walk(fullPath)) {
          return true;
        }
      } else if (matcher(fullPath, entry.name)) {
        return true;
      }
    }

    return false;
  }

  return walk(root);
}

function detectNodeTest(root) {
  const packageJson = readJsonIfExists(root, "package.json");
  if (!packageJson) {
    return null;
  }

  const scripts = packageJson.scripts || {};
  if (scripts["test:backend"] && fileExists(root, "scripts/test-backend.js")) {
    return {
      framework: "node",
      runner: "node",
      command: "node scripts/test-backend.js",
      confidence: "high",
      reason: "TerminalX backend test script was found."
    };
  }

  if (scripts.test) {
    return {
      framework: "node",
      runner: "npm",
      command: "npm test",
      confidence: "high",
      reason: "package.json defines a test script."
    };
  }

  if (hasMatchingFile(root, (_fullPath, name) => /\.(test|spec)\.(js|mjs|cjs)$/.test(name))) {
    return {
      framework: "node",
      runner: "node:test",
      command: "node --test",
      confidence: "medium",
      reason: "JavaScript test files were found."
    };
  }

  return null;
}

function detectRustTest(root) {
  if (!fileExists(root, "Cargo.toml")) {
    return null;
  }

  return {
    framework: "rust",
    runner: "cargo",
    command: "cargo test",
    confidence: "high",
    reason: "Cargo.toml was found."
  };
}

function detectPythonTest(root) {
  const hasPytestConfig = ["pytest.ini", "pyproject.toml", "setup.cfg"].some((file) =>
    fileExists(root, file)
  );
  const hasPythonTests = hasMatchingFile(root, (_fullPath, name) => /^test_.*\.py$|.*_test\.py$/.test(name));

  if (hasPytestConfig || hasPythonTests) {
    return {
      framework: "python",
      runner: hasPytestConfig ? "pytest" : "unittest",
      command: hasPytestConfig ? "python -m pytest" : "python -m unittest discover",
      confidence: hasPytestConfig ? "high" : "medium",
      reason: hasPytestConfig ? "Python test configuration was found." : "Python test files were found."
    };
  }

  return null;
}

function detectGoTest(root) {
  if (!fileExists(root, "go.mod")) {
    return null;
  }

  return {
    framework: "go",
    runner: "go",
    command: "go test ./...",
    confidence: "high",
    reason: "go.mod was found."
  };
}

function detectTestFrameworks(root) {
  return [detectNodeTest(root), detectRustTest(root), detectPythonTest(root), detectGoTest(root)].filter(Boolean);
}

module.exports = { detectTestFrameworks };
