import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hooks.json は JSON として読めて、参照している scripts/*.mjs が実在する", () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.equal(typeof config.hooks, "object");

  const commands = [];
  for (const entries of Object.values(config.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal(hook.type, "command");
        commands.push(hook.command);
      }
    }
  }
  assert.ok(commands.length > 0);

  for (const command of commands) {
    const match = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+\.mjs)/);
    assert.ok(match, `CLAUDE_PLUGIN_ROOT 配下の scripts/*.mjs を参照していること: ${command}`);
    assert.ok(fs.existsSync(path.join(pluginRoot, match[1])), `${match[1]} が存在すること`);
  }
  assert.ok(commands.some((c) => c.includes("scripts/stop-gate.mjs")), "Stop フックが登録されていること");

  const stop = config.hooks.Stop.flatMap((entry) => entry.hooks);
  assert.ok(stop.some((h) => h.command.includes("scripts/stop-gate.mjs")));
  const submit = (config.hooks.UserPromptSubmit ?? []).flatMap((entry) => entry.hooks);
  const arm = submit.find((h) => h.command.includes("scripts/arm-gate.mjs"));
  assert.ok(arm, "UserPromptSubmit に arm-gate が登録されていること");
  assert.ok(arm.timeout <= 15, "プロンプト処理を長く待たせない");
});
