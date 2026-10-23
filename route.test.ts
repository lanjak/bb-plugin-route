import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDecideRequest,
  describeWorker,
  formatDecision,
  parseModels,
  parseWorkers,
  truncate,
  workersSettingSchema,
} from "./lib.ts";

test("parseModels reads name=model and bare ids, keeping '/', ':' and '=' in model ids", () => {
  assert.deepEqual(parseModels("fast=org/model:free\n  gpt-5-mini , odd=a=b\n=missing\n"), [
    { name: "fast", model: "org/model:free" },
    { name: "gpt-5-mini", model: "gpt-5-mini" },
    { name: "odd", model: "a=b" },
  ]);
  assert.deepEqual(parseModels(""), []);
});

test("parseWorkers accepts any provider/model and rejects bad entries", () => {
  assert.deepEqual(parseWorkers(""), []);
  const workers = parseWorkers(
    '[{"name":"cheap","provider":"codex","model":"gpt-5-mini","permissionMode":"auto"},{"name":"default-model","provider":"claude-code"}]',
  );
  assert.equal(workers.length, 2);
  assert.equal(describeWorker(workers[0]), "cheap (codex gpt-5-mini)");
  assert.equal(describeWorker(workers[1]), "default-model (claude-code)");
  assert.throws(() => parseWorkers("{"), /JSON array/);
  assert.throws(() => parseWorkers('[{"name":"a","provider":"x"},{"name":"a","provider":"y"}]'), /duplicate/);
  assert.throws(() => parseWorkers('[{"name":"a","provider":"x","permissionMode":"yolo"}]'), /workers:/);
  assert.equal(workersSettingSchema.safeParse("[]").success, true);
  assert.equal(workersSettingSchema.safeParse('[{"name":"has space","provider":"x"}]').success, false);
});

test("truncate marks what it cut", () => {
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(truncate("abcdef", 2), "ab\n[truncated 4 chars]");
});

test("options become a numbered choice, ranked in the answer", () => {
  const input = { question: "Which queue?", options: ["pg-boss", "BullMQ", "SQS"] };
  const request = buildDecideRequest("some-model", input);
  assert.deepEqual(request.questions.decision, {
    type: "choice",
    instructions: "Which queue?",
    criteria: { "1": "pg-boss", "2": "BullMQ", "3": "SQS" },
  });
  const text = formatDecision(input, {
    model: "m-1",
    answers: { decision: { type: "choice", probabilities: { "1": 0.2, "2": 0.7, "3": 0.1 } } },
  });
  assert.equal(text, "pick: BullMQ (m-1)\n0.70  BullMQ\n0.20  pg-boss\n0.10  SQS");
});

test("no options is a yes/no question", () => {
  const input = { question: "Is the sky blue?" };
  assert.equal(buildDecideRequest("m", input).questions.decision.type, "noul");
  assert.equal(formatDecision(input, { model: "j", answers: { decision: { noul: 0.96 } } }), "yes (p(yes)=0.96, j)");
  assert.throws(() => formatDecision(input, { answers: {} }), /no answer/);
});
