import { createApp } from "./app.js";

const rawPort = process.env["PORT"] ?? "3001";
const parsedPort = Number(rawPort);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3001;

const app = createApp();

app.listen(port);
