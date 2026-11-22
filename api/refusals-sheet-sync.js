// POST /api/refusals-sheet-sync — переносить у Google Таблицю всі відмови з бази
// (наприклад, зібрані до підключення таблиці). Повторний запуск безпечний: наявні рядки
// оновлюються, а не дублюються. Захищено заголовком X-Sheet-Secret: <GOOGLE_SHEET_SECRET>.

const { env, rpc, sameSecret } = require("./_telegram");
const { configured, sheetSaveMany } = require("./_sheets");

const WINDOW_DAYS = 400; // більше база за раз не віддає
const WINDOWS = 3; // скільки вікон назад дивитися (~3 роки)
const BATCH = 200;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!sameSecret(req.headers["x-sheet-secret"], env("GOOGLE_SHEET_SECRET"))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!configured()) return res.status(500).json({ error: "GOOGLE_SHEET_WEBHOOK_URL не задано" });

  try {
    const rows = [];
    let to = new Date();
    for (let i = 0; i < WINDOWS; i++) {
      const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const part = (await rpc("refusals_range", { p_from: from.toISOString(), p_to: to.toISOString() })) || [];
      rows.unshift(...part);
      to = from;
    }
    for (let i = 0; i < rows.length; i += BATCH) await sheetSaveMany(rows.slice(i, i + BATCH));
    return res.status(200).json({ ok: true, synced: rows.length });
  } catch (err) {
    console.error("[refusals-sheet-sync]", err.message);
    return res.status(502).json({ error: err.message });
  }
};
