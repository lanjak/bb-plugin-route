---
name: route
description: "Configure or troubleshoot the Route plugin tools: route_worker, route_decide, and route_ask."
---

# Route plugin

The Route plugin gives BB threads three tools for in-turn calls to other agents and models.

| Tool | What it does | Backend |
| --- | --- | --- |
| `route_worker` | Starts a hidden child thread on another BB harness and model. The child edits files in the same environment. The tool waits for it and returns its final message. | Any BB provider |
| `route_ask` | Sends one prompt to another model and returns the text. It cannot edit files. | Any OpenAI-compatible API |
| `route_decide` | Asks a decision model a choice or yes/no question and returns the ranked options. | Any System One endpoint (for example TypeSafe Jev) |

The plugin has no preset endpoints, keys, or models. A thread gets a tool only after its settings are complete. A settings change applies to threads that start after the change.

## Settings

Show the settings with `bb plugin config route`. Change one with `bb plugin config route set <key> <value>`.

### route_worker

- `workers`: a JSON array. Each entry has `name`, `provider`, and optional `model`, `reasoningLevel`, and `permissionMode` (`accept-edits`, `auto`, or `full`). The first entry is the default. Get the ids from `bb provider list` and `bb provider models <provider>`.
- `workerTimeoutMinutes`: the time limit for one worker. The default is 20.

```json
[
  { "name": "cheap", "provider": "codex", "model": "gpt-5-mini", "reasoningLevel": "low" },
  { "name": "claude", "provider": "claude-code", "model": "claude-haiku-5-5" }
]
```

`permissionMode` defaults to `full`, because nobody approves the actions of a hidden worker. Set a stricter mode only for a harness that can work without approvals.

### route_ask

- `askBaseUrl`: the base URL of an OpenAI-compatible API, including `/v1`. For example `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`.
- `askApiKey`: the API key. This setting is secret. Leave it empty for an endpoint without auth.
- `askModels`: one `name=model` entry per line. A bare model id names itself. The first entry is the default.

### route_decide

- `decideUrl`: the full URL of a System One endpoint. For example `https://api.typesafe.ai/v1/systemone`, or `<gateway>/v1/systemone` for a gateway that serves System One.
- `decideApiKey`: the API key. This setting is secret.
- `decideModel`: the decision model id at that endpoint, for example `jev-latest`.

## Limits

- Only one `route_worker` can run in an environment at a time, because the worker and the caller edit the same files.
- A worker that times out is stopped. Its edits stay in the environment. A failed worker stays unarchived so that you can open it.
- A worker that finishes is stopped and archived. You can still open it by its thread ID.
- Tool output is limited to 12,000 characters.

## Troubleshooting

- A tool is missing: complete its settings, then start a new thread.
- `route_worker` fails at once: check that the provider and model ids exist with `bb provider models <provider>`.
- `HTTP 401` or `HTTP 403`: check the API key for that tool.
- Read the plugin log with `bb plugin logs route`.
