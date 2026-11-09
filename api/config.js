// GET /api/config — публічні налаштування Supabase для адмін-панелі.
// Значення беруться з налаштувань Vercel (Environment Variables), а не з коду.
// Publishable-ключ призначений для браузера: без входу він дозволяє лише додати заявку.

module.exports = function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Supabase не налаштовано у Vercel" });
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json({ supabaseUrl, supabaseKey });
};
