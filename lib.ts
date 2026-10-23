// Pure helpers for the route tools. No BB or network access, so tests can run them directly.
import { z } from "zod";

export const MAX_OUTPUT_CHARS = 12_000;

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

const workerSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, "name may use letters, digits, '_', '.' and '-'"),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningLevel: z.string().min(1).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});
export type Worker = z.infer<typeof workerSchema>;

const workersSchema = z.array(workerSchema).superRefine((workers, ctx) => {
  const seen = new Set<string>();
  for (const worker of workers) {
    if (seen.has(worker.name)) ctx.addIssue({ code: "custom", message: `duplicate worker name "${worker.name}"` });
    seen.add(worker.name);
  }
});

/** Parses the `workers` setting: a JSON array of { name, provider, model?, reasoningLevel?, permissionMode? }. */
export function parseWorkers(value: string): Worker[] {
  if (!value.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("workers must be a JSON array");
  }
  const result = workersSchema.safeParse(raw);
  if (!result.success) throw new Error(`workers: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

/** Validator for the settings page: same rules as parseWorkers. */
export const workersSettingSchema = z.string().refine(
  (value) => {
    try {
      parseWorkers(value);
      return true;
    } catch {
      return false;
    }
  },
  'workers must be a JSON array of {"name", "provider", "model"?, "reasoningLevel"?, "permissionMode"?} with unique names',
);

/**
 * Parses `name=model` entries, one per line or separated by commas. A bare `model` names itself.
 * The first '=' splits, so model ids may contain '/', ':' or '='.
 */
export function parseModels(value: string): { name: string; model: string }[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("=");
      if (at < 0) return { name: entry, model: entry };
      return { name: entry.slice(0, at).trim(), model: entry.slice(at + 1).trim() };
    })
    .filter((entry) => entry.name && entry.model);
}

export function describeWorker(worker: Worker): string {
  return `${worker.name} (${worker.provider}${worker.model ? ` ${worker.model}` : ""})`;
}

export type DecideInput = { question: string; context?: string; options?: string[] };

/** One System One question: a choice over the options, or a yes/no (noul) without options. */
export function buildDecideRequest(model: string, input: DecideInput) {
  const state = input.context?.trim() || "A coding agent needs a decision.";
  const options = input.options ?? [];
  const question =
    options.length > 0
      ? {
          type: "choice",
          instructions: input.question,
          criteria: Object.fromEntries(options.map((option, index) => [String(index + 1), option])),
        }
      : {
          type: "noul",
          instructions: input.question,
          criteria: { false: "no", true: "yes" },
        };
  return { model, state, questions: { decision: question } };
}

/** Turns a System One response into short text: the pick, then every option ranked. */
export function formatDecision(input: DecideInput, response: unknown): string {
  const body = response as {
    model?: string;
    answers?: { decision?: { noul?: number; probabilities?: Record<string, number> } };
  };
  const answer = body.answers?.decision;
  if (!answer) throw new Error(`The decision model returned no answer: ${truncate(JSON.stringify(response), 300)}`);
  const model = body.model ?? "decision model";
  const options = input.options ?? [];
  if (options.length === 0) {
    const yes = answer.noul ?? NaN;
    if (!Number.isFinite(yes)) throw new Error("The decision model returned no yes/no probability");
    return `${yes >= 0.5 ? "yes" : "no"} (p(yes)=${yes.toFixed(2)}, ${model})`;
  }
  const ranked = Object.entries(answer.probabilities ?? {})
    .map(([key, p]) => ({ option: options[Number(key) - 1], p }))
    .filter((row) => row.option !== undefined)
    .sort((a, b) => b.p - a.p);
  if (ranked.length === 0) throw new Error("The decision model returned no option probabilities");
  const lines = ranked.map((row) => `${row.p.toFixed(2)}  ${row.option}`);
  return `pick: ${ranked[0].option} (${model})\n${lines.join("\n")}`;
}
