import "dotenv/config";

import { listLocalModelRuns } from "../src/db.ts";

const limit = Math.max(1, Number(process.argv[2] ?? 10) || 10);
const rows = listLocalModelRuns(limit);

if (rows.length === 0) {
  console.log("No local_model_runs yet.");
  process.exit(0);
}

for (const row of rows.reverse()) {
  console.log("─".repeat(72));
  console.log(
    `#${row.id} until_id=${row.until_id} status=${row.status} ` +
      `ms=${row.duration_ms ?? "—"} input_chars=${row.input_chars}`,
  );
  console.log(
    `cloud: ${row.cloud_backend} / ${row.cloud_model}` +
      `  |  local: ${row.local_model}`,
  );
  console.log(`created: ${row.created_at}`);
  if (row.error) {
    console.log(`error: ${row.error}`);
  }
  console.log("\nCLOUD SUMMARY:");
  console.log(row.cloud_summary || "(empty)");
  console.log("\nLOCAL SUMMARY:");
  console.log(row.local_summary || "(empty)");
  console.log("");
}
