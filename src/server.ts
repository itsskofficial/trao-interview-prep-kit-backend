import { createApp } from "./api/app";
import { loadConfig, loadEnvFile } from "./config";
import { connectDatabase } from "./persistence/mongo";

loadEnvFile();
const config = loadConfig();
const db = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
const server = createApp({ db, config }).listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void db.close().finally(() => process.exit(0)));
  });
}
