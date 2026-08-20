import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIife } from "./helpers/load-iife.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.resolve(here, "../js/tools/registry.js");

function loadRegistry(overrides = {}) {
  return loadIife(registryFile, overrides).WpsAiToolRegistry;
}

test("runtime schema validation rejects a missing required argument", async () => {
  let calls = 0;
  const registry = loadRegistry();
  registry.registerTool({
    name: "contract_required",
    hosts: ["*"],
    sideEffect: "none",
    parameters: {
      type: "object",
      required: ["expectedText"],
      properties: { expectedText: { type: "string", minLength: 1 } }
    },
    handler: async () => { calls += 1; }
  });

  const result = await registry.execute("contract_required", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /INVALID_TOOL_ARGUMENTS/);
  assert.equal(calls, 0);
});

test("execute rejects a tool on the wrong host", async () => {
  let calls = 0;
  const registry = loadRegistry({
    WpsAiSnapshot: { detectHost: () => "wps" }
  });
  registry.registerTool({
    name: "contract_et_only",
    hosts: ["et"],
    sideEffect: "none",
    parameters: { type: "object", properties: {} },
    handler: async () => { calls += 1; }
  });

  const result = await registry.execute("contract_et_only", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /HOST_MISMATCH/);
  assert.equal(calls, 0);
});

test("document mutation fails closed when backup returns no backupPath", async () => {
  let calls = 0;
  let started = 0;
  const history = {
    isMutatingTool: () => true,
    getCurrentTurnId: () => null,
    startTurn: () => { started += 1; return "synthetic-turn"; },
    ensureBackupForTurn: async () => null,
    getTurnBackupError: () => null,
    getFriendlyName: (name) => name,
    addEntry: () => {}
  };
  const registry = loadRegistry({
    WpsAiHistory: history,
    WpsAiSnapshot: {
      detectHost: () => "wps",
      captureBefore: async () => ({})
    },
    WpsAiBackup: { getCurrentDocPath: () => "/tmp/contract.docx" }
  });
  registry.registerTool({
    name: "contract_document_write",
    hosts: ["wps"],
    sideEffect: "document",
    parameters: { type: "object", properties: {} },
    handler: async () => { calls += 1; return { changed: true }; }
  });

  const result = await registry.execute("contract_document_write", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /备份|BACKUP/);
  assert.equal(started, 1);
  assert.equal(calls, 0);
});

test("duplicate tool registration requires an explicit replacement declaration", () => {
  const registry = loadRegistry();
  registry.registerTool({
    name: "contract_duplicate",
    origin: "core",
    hosts: ["*"],
    handler: async () => null
  });
  assert.throws(() => registry.registerTool({
    name: "contract_duplicate",
    origin: "patch",
    hosts: ["*"],
    handler: async () => null
  }), /duplicate|重复|replaces/i);

  assert.doesNotThrow(() => registry.registerTool({
    name: "contract_duplicate",
    origin: "patch",
    replaces: "core",
    hosts: ["*"],
    handler: async () => null
  }));
  assert.equal(registry.getDefinition("contract_duplicate").origin, "patch");
});
