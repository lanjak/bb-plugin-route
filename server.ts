// Route: in-turn calls from a BB thread to other agents and models.
//   route_worker  hands a task to another BB harness/model that edits files in the same environment
//   route_decide  asks a System One decision model (for example TypeSafe Jev) for a typed decision
//   route_ask     asks a model on any OpenAI-compatible endpoint and returns its text
// Nothing is preconfigured: each tool is offered only after its settings are filled in.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildDecideRequest,
  describeWorker,
  formatDecision,
  parseModels,
  parseWorkers,
  truncate,
  workersSettingSchema,
} from "./lib.ts";

const POLL_MS = 2_000;
const HTTP_TIMEOUT_MS = 120_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    workers: {
      type: "string",
      label: "Workers",
      description:
        'JSON array of BB harnesses route_worker may use. The first is the default. Example: [{"name": "cheap", "provider": "codex", "model": "gpt-5-mini", "reasoningLevel": "low", "permissionMode": "full"}]. provider and model are the ids from `bb provider list` and `bb provider models <provider>`. permissionMode defaults to full, because nobody approves a hidden worker\'s actions.',
      experimental_multiline: true,
      experimental_schema: workersSettingSchema,
      default: "[]",
    },
    workerTimeoutMinutes: {
      type: "number",
      label: "Worker timeout (minutes)",
      experimental_schema: z.number().int().min(1).max(240),
      default: 20,
    },
    askBaseUrl: {
      type: "string",
      label: "route_ask endpoint",
      description: "Base URL of an OpenAI-compatible API, including /v1. Requests go to <URL>/chat/completions.",
      default: "",
    },
    askApiKey: { type: "string", label: "route_ask API key", secret: true },
    askModels: {
      type: "string",
      label: "route_ask models",
      description: "One name=model per line (or a bare model id). The first is the default. Example: fast=gpt-5-mini",
      experimental_multiline: true,
      default: "",
    },
    decideUrl: {
      type: "string",
      label: "route_decide endpoint",
      description: "Full URL of a System One endpoint, for example https://api.typesafe.ai/v1/systemone or <gateway>/v1/systemone.",
      default: "",
    },
    decideApiKey: { type: "string", label: "route_decide API key", secret: true },
    decideModel: {
      type: "string",
      label: "route_decide model",
      description: "Decision model id at that endpoint, for example jev-latest.",
      default: "",
    },
  });

  // configure() is synchronous, so keep a parsed snapshot of the settings.
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  const workers = () => {
    try {
      return parseWorkers(current.workers);
    } catch {
      return [];
    }
  };
  const askModels = () => parseModels(current.askModels);
  const askReady = () => Boolean(current.askBaseUrl.trim()) && askModels().length > 0;
  const decideReady = () => Boolean(current.decideUrl.trim() && current.decideModel.trim());

  bb.agents.configure(() => {
    const tools: string[] = [];
    const lines: string[] = [];
    const pool = workers();
    if (pool.length > 0) {
      tools.push("route_worker");
      lines.push(`route_worker workers: ${pool.map(describeWorker).join(", ")}. Default: ${pool[0].name}.`);
    }
    if (askReady()) {
      tools.push("route_ask");
      lines.push(`route_ask models: ${askModels().map((m) => (m.name === m.model ? m.name : `${m.name} (${m.model})`)).join(", ")}.`);
    }
    if (decideReady()) tools.push("route_decide");
    return { tools, skills: ["route"], instructions: lines.join("\n") };
  });

  async function post(url: string, apiKey: string | undefined, body: unknown, signal: AbortSignal) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${truncate(text, 500)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${url} returned a non-JSON body: ${truncate(text, 300)}`);
    }
  }

  bb.agents.registerTool({
    name: "route_decide",
    description:
      "Ask a decision model for a fast typed decision. With options: returns the pick and every option ranked by probability. Without options: a yes/no answer with p(yes).",
    instructions:
      "For a judgement call between known options (which approach, which file, is X relevant), call route_decide before reasoning at length. Treat a top probability below 0.6 as uncertain.",
    presentation: { label: { pending: "Asking the decision model", completed: "Asked the decision model" } },
    parameters: z.object({
      question: z.string().min(1).max(4_000),
      options: z.array(z.string().min(1).max(500)).min(2).max(64).optional(),
      context: z.string().max(8_000).optional().describe("Facts the decision depends on."),
    }),
    async execute(input, { signal }) {
      const { decideUrl, decideApiKey, decideModel } = await settings.get();
      if (!decideUrl.trim() || !decideModel.trim()) throw new Error("route_decide is not configured: set decideUrl and decideModel");
      const response = await post(decideUrl.trim(), decideApiKey, buildDecideRequest(decideModel.trim(), input), signal);
      return formatDecision(input, response);
    },
  });

  bb.agents.registerTool({
    name: "route_ask",
    description:
      "Ask another model a self-contained question and get its text answer. It sees only the prompt you send, not this thread, and cannot edit files.",
    instructions:
      "Use route_ask for bounded mechanical work (extract, summarize, reformat) and for a second opinion. Put everything the model needs in the prompt.",
    presentation: { label: { pending: "Asking another model", completed: "Asked another model" } },
    parameters: z.object({
      prompt: z.string().min(1).max(200_000),
      model: z.string().optional().describe("A route_ask model name from this thread's instructions. Default: the first one."),
      system: z.string().max(8_000).optional(),
      maxTokens: z.number().int().min(16).max(32_000).optional(),
    }),
    async execute({ prompt, model, system, maxTokens }, { signal }) {
      const config = await settings.get();
      const models = parseModels(config.askModels);
      const entry = model ? models.find((m) => m.name === model) : models[0];
      if (!config.askBaseUrl.trim() || !entry) {
        throw new Error(
          models.length === 0
            ? "route_ask is not configured: set askBaseUrl and askModels"
            : `Unknown model "${model}". Use one of: ${models.map((m) => m.name).join(", ")}`,
        );
      }
      const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
      const body = (await post(
        `${config.askBaseUrl.trim().replace(/\/+$/, "")}/chat/completions`,
        config.askApiKey,
        { model: entry.model, messages, max_tokens: maxTokens ?? 4_096, stream: false },
        signal,
      )) as { choices?: { message?: { content?: string | null } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${entry.model} returned no text`);
      return `[${entry.model}]\n${truncate(content)}`;
    },
  });

  // shortcut: one worker per environment so two agents never edit the same checkout at once;
  // add a worktree option if parallel workers are needed.
  const busyEnvironments = new Set<string>();

  bb.agents.registerTool({
    name: "route_worker",
    description:
      "Hand a self-contained task to another coding agent. It runs as a hidden child thread in this thread's environment, edits the same files, and returns its final message when done. Blocks until it finishes or times out.",
    instructions:
      "Use route_worker for well-specified, mechanical edits (renames, boilerplate, simple tests, applying a pattern you have already decided). Name the files and the expected result in the task. After it returns, review the diff yourself before you continue.",
    presentation: { label: { pending: "Delegating to a worker", completed: "Worker finished" } },
    parameters: z.object({
      task: z.string().min(1).max(50_000),
      worker: z.string().optional().describe("A worker name from this thread's instructions. Default: the first one."),
    }),
    async execute({ task, worker: name }, { threadId, projectId, signal }) {
      const config = await settings.get();
      const pool = parseWorkers(config.workers);
      const chosen = name ? pool.find((w) => w.name === name) : pool[0];
      if (!chosen) {
        throw new Error(
          pool.length === 0
            ? "route_worker is not configured: add at least one entry to workers"
            : `Unknown worker "${name}". Use one of: ${pool.map((w) => w.name).join(", ")}`,
        );
      }
      const label = describeWorker(chosen);
      const parent = await bb.sdk.threads.get({ threadId });
      const environmentId = parent.environmentId;
      if (!environmentId) throw new Error("This thread has no environment yet");
      if (busyEnvironments.has(environmentId)) {
        throw new Error("A worker is already running in this environment. Wait for it to finish.");
      }
      busyEnvironments.add(environmentId);
      let workerId: string | undefined;
      let finished = false;
      try {
        const spawned = await bb.sdk.threads.spawn({
          projectId,
          environment: { type: "reuse", environmentId },
          prompt: task,
          providerId: chosen.provider,
          ...(chosen.model ? { model: chosen.model } : {}),
          ...(chosen.reasoningLevel ? { reasoningLevel: chosen.reasoningLevel } : {}),
          permissionMode: chosen.permissionMode ?? "full",
          visibility: "hidden",
          parentThreadId: threadId,
          lifecycleOwnerThreadId: threadId,
          title: `route_worker ${chosen.name}: ${task.slice(0, 60)}`,
        });
        workerId = spawned.id;
        const deadline = Date.now() + config.workerTimeoutMinutes * 60_000;
        let started = false;
        for (;;) {
          signal.throwIfAborted();
          const { status } = await bb.sdk.threads.get({ threadId: workerId });
          if (status === "error") throw new Error(`Worker ${workerId} ${label} failed. Open it to see why.`);
          if (status !== "idle") started = true;
          if (status === "idle") {
            const { output } = await bb.sdk.threads.output({ threadId: workerId });
            if (started || output) {
              finished = true;
              return `Worker ${workerId} ${label} finished:\n${truncate(output ?? "(no final message)")}`;
            }
          }
          if (Date.now() > deadline) {
            throw new Error(
              `Worker ${workerId} ${label} timed out after ${config.workerTimeoutMinutes} minutes and was stopped. Its edits stay in the environment.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } finally {
        busyEnvironments.delete(environmentId);
        if (workerId) {
          // Stop always frees the agent process; keep failed workers unarchived so they can be inspected.
          const id = workerId;
          await bb.sdk.threads.stop({ threadId: id }).catch((error) => bb.log.warn(`stop ${id}: ${error}`));
          if (finished) await bb.sdk.threads.archive({ threadId: id }).catch(() => undefined);
        }
      }
    },
  });
}
