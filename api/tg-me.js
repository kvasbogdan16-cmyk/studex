// POST /api/tg-me — хто відкрив Mini App і його заявки.
// Користувача беремо лише з initData, підпис якого перевіряємо ключем бота.

const { verifyInitData, displayName, rpc, parseBody, sendError } = require("./_telegram");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { initData } = parseBody(req);
    const user = verifyInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    const leads = await rpc("tg_my_leads", { p_telegram_id: user.id });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      user: { first_name: user.first_name || "", name: displayName(user), username: user.username || "" },
      leads: (leads || []).map((l) => ({
        id: l.id,
        created_at: l.created_at,
        comment: l.comment,
        stage: l.stage,
        stage_kind: l.stage_kind,
      })),
    });
  } catch (err) {
    return sendError(res, err);
  }
};
