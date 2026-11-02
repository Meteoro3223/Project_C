import { loadEnv } from "./env.js";
import { createApp } from "./app.js";

// Fail fast with a clear message when DATABASE_URL is missing. The repo-root
// `.env` is already loaded by `env.ts` (or by `--env-file-if-exists` flags).
const env = loadEnv();

// Composition root: the only place that reads NODE_ENV to decide cookie flags.
const app = createApp({ secureCookies: process.env["NODE_ENV"] === "production" });

app.listen(env.port);
