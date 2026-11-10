// Manage the local dev server: start | stop | restart | status
// Usage: node scripts/dev-server-ctl.js <action> [port]
// Serves the project folder that contains this script. Logs go to .dev-server.log.
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const action = (process.argv[2] || "status").toLowerCase();
const port = Number(process.argv[3] || 3000);
const root = path.resolve(__dirname, "..");
const serverScript = path.join(__dirname, "dev-server.js");
const logFile = path.join(root, ".dev-server.log");

function ps(cmd) {
  return execSync(`powershell -NoProfile -NonInteractive -Command "${cmd}"`, { encoding: "utf8" }).trim();
}

// Processes listening on the port: [{pid, cmd}]
function listeners() {
  const out = ps(
    `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; ` +
    `foreach ($id in $p) { $c = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id)).CommandLine; Write-Output ($id.ToString() + '|' + $c) }; exit 0`
  );
  return out ? out.split(/\r?\n/).map((l) => { const i = l.indexOf("|"); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }; }) : [];
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stop() {
  const procs = listeners();
  if (!procs.length) { console.log(`STOPPED: nothing was listening on port ${port}`); return true; }
  const foreign = procs.filter((p) => !/dev-server\.js/i.test(p.cmd || ""));
  if (foreign.length) {
    console.log(`ERROR: port ${port} is used by another program, not touching it:`);
    foreign.forEach((p) => console.log(`  PID ${p.pid}: ${p.cmd}`));
    return false;
  }
  for (const p of procs) {
    ps(`Stop-Process -Id ${p.pid} -Force`);
    console.log(`Stopped PID ${p.pid}`);
  }
  for (let i = 0; i < 20 && listeners().length; i++) await sleep(250);
  console.log(`STOPPED: port ${port} is free`);
  return true;
}

async function start() {
  if (listeners().length) {
    const code = await ping();
    console.log(`ALREADY RUNNING: http://localhost:${port} (HTTP ${code})`);
    return code !== null;
  }
  const log = fs.openSync(logFile, "w");
  const child = spawn(process.execPath, [serverScript, root, String(port)], {
    detached: true, stdio: ["ignore", log, log], windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const code = await ping();
    if (code !== null) {
      console.log(`RUNNING: http://localhost:${port} (HTTP ${code}, PID ${child.pid}, root: ${root})`);
      return true;
    }
  }
  console.log(`ERROR: server did not respond within 10s. Log (${logFile}):`);
  console.log(fs.readFileSync(logFile, "utf8"));
  return false;
}

async function status() {
  const procs = listeners();
  if (!procs.length) { console.log(`NOT RUNNING on port ${port}`); return true; }
  const code = await ping();
  procs.forEach((p) => console.log(`RUNNING: PID ${p.pid} (HTTP ${code}) ${p.cmd}`));
  return true;
}

(async () => {
  let ok;
  if (action === "start") ok = await start();
  else if (action === "stop") ok = await stop();
  else if (action === "restart") ok = (await stop()) && (await start());
  else if (action === "status") ok = await status();
  else { console.log("Usage: node scripts/dev-server-ctl.js start|stop|restart|status [port]"); ok = false; }
  process.exit(ok ? 0 : 1);
})();
