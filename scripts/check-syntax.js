// npm test: перевірка синтаксису всіх JS-файлів проєкту (node --check).
// Тестів у проєкті поки немає; це мінімальна перевірка, яку запускає хук перед комітом.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const dirs = [".", "api", "scripts"];

const files = dirs.flatMap((dir) => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(abs, name));
});

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}\n${r.stderr}`);
  }
}

console.log(`${files.length - failed}/${files.length} JS-файлів без синтаксичних помилок`);
process.exit(failed ? 1 : 0);
