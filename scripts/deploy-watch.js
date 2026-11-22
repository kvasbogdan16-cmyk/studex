// Watch a Vercel deployment: check its status every 10 s until it is READY or fails.
// Usage:
//   node scripts/deploy-watch.js                       -> newest deployment of the project
//   node scripts/deploy-watch.js <deployment-url>      -> that deployment
//   node scripts/deploy-watch.js --since=<unix ms>     -> wait for a deployment created after that
//                                                          moment (e.g. right after git push)
//   add --prod                                          -> consider only production deployments
//                                                          (a push to main AND to a branch creates
//                                                          two deployments: production + preview)
// Exit codes: 0 = READY, 1 = ERROR/CANCELED (build log tail printed), 2 = timeout / no deployment.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 9 * 60_000;      // stays under the 10-minute shell limit
const NEW_DEPLOY_WAIT_MS = 2 * 60_000; // how long to wait for a deployment to appear after a push

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const sinceArg = args.find((a) => a.startsWith("--since="));
const since = sinceArg ? Number(sinceArg.slice(8)) : null;
const prodOnly = args.includes("--prod");
let target = args.find((a) => !a.startsWith("--")) || null;

function vercel(cliArgs) {
  // One command string: on Windows `vercel` is a .cmd shim, which needs a shell.
  const cmd = ["vercel", ...cliArgs.map((a) => `"${String(a).replace(/"/g, "")}"`)].join(" ");
  const r = spawnSync(cmd, { cwd: root, encoding: "utf8", shell: true, timeout: 60_000 });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function json(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toLocaleTimeString("uk-UA");
const log = (msg) => console.log(`[${time()}] ${msg}`);

function projectName() {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".vercel", "project.json"), "utf8")).projectName; }
  catch { return null; }
}

function deployments() {
  const name = projectName();
  const data = json(vercel(["ls", ...(name ? [name] : []), "--format", "json"]).out);
  return (data && data.deployments) || [];
}

async function pickTarget() {
  if (target) return target;
  const started = Date.now();
  while (true) {
    const list = deployments();
    const found = list.find((d) => (since === null || d.createdAt >= since) && (!prodOnly || d.target === "production"));
    if (found) return found.url;
    if (since === null || Date.now() - started > NEW_DEPLOY_WAIT_MS) return null;
    log(`Нового ${prodOnly ? "production-" : ""}деплою ще немає, чекаю 10 с...`);
    await sleep(INTERVAL_MS);
  }
}

(async () => {
  if (!fs.existsSync(path.join(root, ".vercel", "project.json"))) {
    console.log("ERROR: проєкт не під'єднаний до Vercel (немає .vercel/project.json). Виконай `vercel link`.");
    process.exit(2);
  }

  target = await pickTarget();
  if (!target) { console.log("RESULT: NO_DEPLOYMENT — новий деплой так і не з'явився."); process.exit(2); }
  log(`Стежу за деплоєм: https://${target.replace(/^https?:\/\//, "")}`);

  const started = Date.now();
  let last = "";
  while (Date.now() - started < MAX_WAIT_MS) {
    const info = json(vercel(["inspect", target, "--json"]).out);
    const state = info ? String(info.readyState || info.state || "UNKNOWN").toUpperCase() : "UNKNOWN";
    if (state !== last) log(`Статус: ${state}`); else log(`Статус: ${state} (без змін)`);
    last = state;

    if (state === "READY") {
      console.log(`RESULT: READY — ${info.url} (target: ${info.target || "preview"})`);
      process.exit(0);
    }
    if (state === "ERROR" || state === "CANCELED") {
      console.log(`RESULT: ${state} — ${info.url}`);
      console.log("----- Кінець логу збірки -----");
      const logs = vercel(["inspect", target, "--logs"]);
      const lines = `${logs.out}\n${logs.err}`.split(/\r?\n/).filter(Boolean);
      console.log(lines.slice(-80).join("\n"));
      process.exit(1);
    }
    await sleep(INTERVAL_MS);
  }
  console.log(`RESULT: TIMEOUT — деплой не завершився за ${MAX_WAIT_MS / 60000} хв. Запусти скрипт ще раз з URL ${target}.`);
  process.exit(2);
})();
