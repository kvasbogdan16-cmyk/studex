// Stop hook: after an approved plan was implemented, ask Claude to restart
// the dev server through the `dev-server` subagent.
//
// Fires when: the transcript has an ExitPlanMode call, files were edited after it,
// and the dev-server agent has not been run since the last edit.
const fs = require("fs");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw.replace(/^﻿/, "").trim() || "{}");
    if (input.stop_hook_active) return; // already continued once because of a hook
    if (!input.transcript_path || !fs.existsSync(input.transcript_path)) return;

    let lastPlan = -1, lastEdit = -1, lastDevServer = -1, i = 0;
    for (const line of fs.readFileSync(input.transcript_path, "utf8").replace(/^﻿/, "").split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const content = entry && entry.type === "assistant" && entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== "tool_use") continue;
        i++;
        if (block.name === "ExitPlanMode") lastPlan = i;
        else if (EDIT_TOOLS.has(block.name)) lastEdit = i;
        else if (AGENT_TOOLS.has(block.name) && block.input && block.input.subagent_type === "dev-server") lastDevServer = i;
      }
    }

    if (lastPlan > 0 && lastEdit > lastPlan && lastDevServer < lastEdit) {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: "План реалізовано і файли змінено. Запусти субагента dev-server (Agent, subagent_type: \"dev-server\") з завданням перезапустити дев-сервер, а потім коротко повідом користувачу результат.",
      }));
    }
  } catch {
    // never break the session because of this hook
  }
});
