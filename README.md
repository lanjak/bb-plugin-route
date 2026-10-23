# bb-plugin-route

A headless BB plugin that lets an agent call other agents and models during its turn:

- `route_worker` gives a task to another BB harness and model. That agent edits the same files.
- `route_ask` asks a model on any OpenAI-compatible API.
- `route_decide` asks a System One decision model (for example TypeSafe Jev) for a typed decision.

The plugin has no preset endpoints, keys, or models. Each tool appears only after you configure it. See [skills/route/SKILL.md](skills/route/SKILL.md) for the settings.

## Quick start

```sh
bb plugin install <path or git URL>
bb plugin config route set workers '[{"name":"cheap","provider":"codex","model":"gpt-5-mini"}]'
bb plugin config route set askBaseUrl https://openrouter.ai/api/v1
bb plugin config route set askApiKey <key>
bb plugin config route set askModels 'fast=openai/gpt-5-mini'
```

Start a new thread to get the tools.

## Develop

```sh
npm install
npm run check   # typecheck
npm test        # unit tests for lib.ts
bb plugin build
```
