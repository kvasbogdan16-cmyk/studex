// Запускає всі тести з tests/*.test.js через вбудований node --test.
// Аргументи навмисно ігноруються: git-guards дописують до GG_TEST_CMD змінені файли,
// а `node --test api/lead.js scripts/dev-server.js` запустив би їх як тести (dev-сервер завис би).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "tests");
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join(dir, f))
  : [];

if (!files.length) {
  console.log("No tests in tests/*.test.js");
  process.exit(0);
}

const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
