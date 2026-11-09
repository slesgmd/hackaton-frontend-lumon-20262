import { execSync, spawnSync } from "node:child_process";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

if (sh("git status --porcelain")) {
  console.error("Abortado: hay cambios sin commitear.");
  process.exit(1);
}
sh("git fetch origin main");
if (sh("git rev-parse HEAD") !== sh("git rev-parse origin/main")) {
  console.error("Abortado: HEAD no coincide con origin/main (falta push o pull).");
  process.exit(1);
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npm", ["run", "build"]);
run("npx", [
  "wrangler",
  "pages",
  "deploy",
  "dist",
  "--project-name",
  "hackaton-frontend-lumon-20262",
  "--branch",
  "main",
]);
console.log(`Desplegado SHA ${sh("git rev-parse --short=7 HEAD")}`);
