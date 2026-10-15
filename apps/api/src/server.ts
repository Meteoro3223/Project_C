import { createApp } from "./app.js";

const rawPort = process.env["PORT"] ?? "4010";
const parsedPort = Number(rawPort);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 4010;

const app = createApp();

app.listen(port);
