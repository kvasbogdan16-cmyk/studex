// PostToolUse hook (PowerShell/Bash): after a deploy command or git push,
// tell Claude to run the `deploy-status` subagent to watch the deployment.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw.replace(/^﻿/, "").trim() || "{}");
    if (input.agent_type === "deploy-status") return; // the watcher itself redeploys — no loop

    const cmd = String((input.tool_input && input.tool_input.command) || "");
    const isCliDeploy = /\bvercel(\.cmd|\.ps1)?\s+(deploy|redeploy|--prod)\b/i.test(cmd) ||
      /\bvercel(\.cmd|\.ps1)?\s*(--yes|-y)?\s*(;|&|\||$)/im.test(cmd);
    const isPush = /\bgit\s+push\b/i.test(cmd);
    if (!isCliDeploy && !isPush) return;

    // Push у main (git push origin main / HEAD:main) деплоїть основний сайт. Якщо в тій самій команді
    // пушать і гілку, Vercel зробить ще й preview-деплой, тож агент має стежити саме за production.
    const toMain = isPush && /\bgit\s+push\b[^;&|\n]*?(?:\s|:)main\b/i.test(cmd);
    const cliProd = isCliDeploy && /--prod\b/i.test(cmd);

    const output = JSON.stringify((input.tool_response && (input.tool_response.stdout || input.tool_response.output)) || input.tool_response || "");
    const url = (output.match(/https:\/\/[a-z0-9-]+-[a-z0-9]+\.vercel\.app/i) || [])[0];
    const since = Date.now() - 60_000;

    const how = url
      ? `Деплой: ${url} — передай агенту цей URL.`
      : isPush
        ? toMain
          ? `Це git push у main (основний сайт): передай агенту, щоб стежив з --prod --since=${since}.`
          : `Це git push у гілку (preview-деплой): передай агенту, щоб стежив з --since=${since}.`
        : cliProd
          ? `URL деплою не знайдено у виводі — передай агенту, щоб стежив з --prod --since=${since}.`
          : `URL деплою не знайдено у виводі — агент візьме найновіший деплой.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Щойно запущено деплой. Запусти субагента deploy-status (Agent, subagent_type: "deploy-status"), ` +
          `щоб він стежив за статусом кожні 10 с і виправив помилку, якщо деплой впаде. ${how} ` +
          `Якщо ти сам і є агент deploy-status — ігноруй це повідомлення і продовжуй стеження.`,
      },
    }));
  } catch {
    // never break the session because of this hook
  }
});
