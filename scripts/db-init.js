const { loadEnvFile } = require("../services/api/src/utils/env");
const { hashPassword } = require("../services/api/src/auth");
const { seedRbac } = require("../services/api/src/rbac");
const { agentRegistry } = require("../services/agent-runtime/src/agents/registry");
const { permissionModes } = require("../services/agent-runtime/src/permissions/modes");
const { createDatabaseRepository, migrateDatabase } = require("../packages/db/client");

loadEnvFile();

const migration = migrateDatabase();
const repository = createDatabaseRepository();

repository.seedAgents(agentRegistry);
repository.seedPermissions(permissionModes);
seedRbac(repository);
repository.seedSettings({
  runtime_mode: process.env.TERMINALX_RUNTIME_MODE || "ONLINE_MODE",
  database_provider: repository.config.provider,
  storage_provider: process.env.FILE_STORAGE_PROVIDER || process.env.STORAGE_PROVIDER || "local"
});
if ((process.env.TERMINALX_ENV || "development") !== "production") {
  const adminUser = repository.upsertUser({
    email: process.env.ADMIN_EMAIL || "admin@terminalx.local",
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "change-me-now"),
    displayName: "TerminalX Admin",
    role: "admin"
  });
  repository.assignRole(adminUser.id, "admin");
}

repository.close?.();

console.log(`Database initialized with ${migration.provider} storage.`);
