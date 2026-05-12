const { loadEnvFile } = require("../services/api/src/utils/env");
const { migrateDatabase } = require("../packages/db/client");

loadEnvFile();

const result = migrateDatabase();
console.log(`Database migration complete for ${result.provider}.`);
