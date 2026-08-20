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

test("host detection falls back to WpsAiDocument for PDF", async () => {
  let calls = 0;
  const registry = loadRegistry({
    WpsAiSnapshot: { detectHost: () => "*" },
    WpsAiDocument: { getHost: async () => "pdf" }
  });
  registry.registerTool({
    name: "contract_pdf_only",
    hosts: ["pdf"],
    sideEffect: "none",
    parameters: { type: "object", properties: {} },
    handler: async () => { calls += 1; return "ok"; }
  });
  const result = await registry.execute("contract_pdf_only", {});
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
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

test("document tools execute inside the unified mutation transaction", async () => {
  let coordinatorCalls = 0;
  let handlerCalls = 0;
  const registry = loadRegistry({
    WpsAiHistory: {
      isMutatingTool: () => true,
      getFriendlyName: (name) => name,
      addEntry: () => {}
    },
    WpsAiSnapshot: {
      detectHost: () => "wps",
      captureBefore: async () => ({ target: { label: "§1" }, before: {}, _captureAfter: async () => ({}) }),
      captureAfter: async () => ({})
    },
    WpsAiBackup: { getCurrentDocPath: () => "/tmp/contract.docx" },
    WpsAiDocumentMutation: {
      run: async (options) => {
        coordinatorCalls += 1;
        const value = await options.mutate(options.args, { turnId: "t1", docPath: "/tmp/contract.docx" });
        return { ok: true, value };
      }
    }
  });
  registry.registerTool({
    name: "contract_coordinated_write",
    hosts: ["wps"],
    sideEffect: "document",
    parameters: { type: "object", properties: {} },
    handler: async () => { handlerCalls += 1; return { applied: true }; }
  });
  const result = await registry.execute("contract_coordinated_write", {});
  assert.equal(result.ok, true);
  assert.equal(coordinatorCalls, 1);
  assert.equal(handlerCalls, 1);
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
