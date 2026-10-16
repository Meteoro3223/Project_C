import { loadEnv } from "./env.js";
import { createApp } from "./app.js";

// Fail fast with a clear message when DATABASE_URL is missing. The repo-root
// `.env` is already loaded by `env.ts` (or by `--env-file-if-exists` flags).
const env = loadEnv();

const app = createApp();

app.listen(env.port);
