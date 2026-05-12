const { Client } = require("pg");

async function main() {
  const request = JSON.parse(process.argv[2] || "{}");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
  });

  await client.connect();
  try {
    const result = await client.query(request.sql, request.params || []);
    process.stdout.write(JSON.stringify({ rows: result.rows || [] }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
