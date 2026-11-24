// Local dev server: static files (cleanUrls) + Vercel-style api/*.js handlers.
// Usage: node scripts/dev-server.js [root] [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const port = Number(process.argv[3] || 3000);

// Load .env.local without printing it
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => { res.end(body); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  console.log(req.method, pathname);

  if (pathname.startsWith("/api/")) {
    const file = path.join(root, "api", pathname.slice(5).replace(/\.js$/, "") + ".js");
    if (!file.startsWith(path.join(root, "api")) || !fs.existsSync(file)) {
      res.statusCode = 404; return res.end("Not found");
    }
    delete require.cache[require.resolve(file)];
    const handler = require(file);
    const raw = await readBody(req);
    req.query = Object.fromEntries(url.searchParams);
    req.body = raw;
    if ((req.headers["content-type"] || "").includes("application/json") && raw) {
      try { req.body = JSON.parse(raw); } catch {}
    }
    try { await handler(req, wrapRes(res)); }
    catch (err) { console.error(err); if (!res.headersSent) { res.statusCode = 500; res.end("Server error"); } }
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";
  // Службові файли (.env.local, .git, .vercel, .claude …) не віддаємо
  if (pathname.split(/[\\/]/).some((part) => part.startsWith("."))) {
    res.statusCode = 404; return res.end("Not found");
  }
  let file = path.join(root, pathname);
  if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
  if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end("Not found");
  }
  res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
});

// Лише цей комп'ютер: інші пристрої в мережі (спільний Wi-Fi) сервер не бачать
server.listen(port, "127.0.0.1", () => console.log(`Ready: http://localhost:${port} (root: ${root})`));
