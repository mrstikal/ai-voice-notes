import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

import nextEnv from "@next/env";

import { loadConfig } from "../src/lib/config.ts";

const { loadEnvConfig } = nextEnv;

const mode = process.argv[2];

if (mode !== "dev" && mode !== "start") {
  console.error("Použití: node scripts/next-server.ts <dev|start>");
  process.exit(1);
}

loadEnvConfig(process.cwd(), mode === "dev");

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Konfigurace aplikace je neplatná.");
  process.exit(1);
}

const nextBinary = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [
    nextBinary,
    mode,
    "--hostname",
    config.appHost,
    "--port",
    String(config.appPort),
  ],
  {
    env: process.env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(`Nepodařilo se spustit Next.js: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
