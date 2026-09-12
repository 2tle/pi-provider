# Pi Provider Manager

[![npm version](https://img.shields.io/npm/v/%402tle%2Fpi-provider-manager)](https://www.npmjs.com/package/@2tle/pi-provider-manager)

An extension for registering and managing OpenAI-compatible API providers in Pi Agent.

When working with local LLM servers, private gateways, proxies, or hosted APIs, managing each provider through `models.json` and restarting Pi can be cumbersome. This extension keeps managed providers and their model catalogs in one place.

## Installation

Install the package from [npm](https://www.npmjs.com/package/@2tle/pi-provider-manager) and register it with Pi:

```bash
pi install npm:@2tle/pi-provider-manager
```

To try it without adding it to your settings:

```bash
pi -e npm:@2tle/pi-provider-manager
```

## Features

- Add OpenAI-compatible providers from the Pi TUI
- List managed providers without exposing API keys
- Edit a provider's display name, Base URL, or API key
- Refresh one provider's model catalog or every managed catalog
- Delete a managed provider and its stored API key
- Keep provider metadata and credentials in separate files

## Commands

### Add a provider

```text
/provider add
```

The interactive flow requests:

1. Provider ID — lowercase letters, numbers, `.`, `_`, and `-` only
2. Provider display name
3. OpenAI-compatible Base URL — for example, `http://localhost:1234/v1`
4. API key — local servers can use a placeholder such as `local`

After the provider is added, its `/models` endpoint is queried immediately.

### List managed providers

```text
/provider list
```

Displays each provider's ID, display name, Base URL, API key status, and the number of currently loaded models. API key values are never displayed.

### Edit a provider

```text
/provider edit <provider_name>
```

Use a provider ID (recommended) or a unique display name. Select the fields to change, then choose **Save changes**. The extension refreshes the provider's model catalog after saving.

In TUI mode, API key input is masked with `*` characters. In RPC mode, the connected client is responsible for secret masking.

### Refresh model catalogs

```text
/provider reload <provider_name>
/provider reload --all
```

The extension sends a request to `<baseUrl>/models` and accepts the OpenAI-style response shape:

```json
{
  "data": [{ "id": "model-name" }]
}
```

This is different from Pi's `/reload`, which reloads extension code and resources.

### Delete a provider

```text
/provider delete <provider_name>
```

After confirmation, the extension removes the managed provider and its stored API key. Built-in providers and providers owned by other extensions cannot be deleted.

## Supported APIs

The extension targets OpenAI Chat Completions-compatible services that provide a model-listing endpoint and support Pi's OpenAI-compatible transport, including:

- OpenAI-compatible gateways and proxies
- vLLM
- LM Studio
- llama.cpp server
- Ollama's OpenAI-compatible endpoint
- Private or internal LLM gateways

Provider implementations differ in support for developer roles, reasoning options, token fields, and streaming usage. This extension currently uses Pi's standard `openai-completions` transport.

### Thinking / reasoning

During each catalog refresh, the extension recognizes OpenAI-compatible reasoning metadata from either top-level fields or `capabilities`:

- `supports_reasoning`, `supports_reasoning_effort`, or `capabilities.supports_reasoning`
- `reasoning_efforts` or `capabilities.reasoning_effort` (an array of strings or `{ "value": "..." }` objects)

Reasoning-capable models are registered with Pi's `reasoning_effort` compatibility enabled. Supported effort values are exposed as Pi thinking levels; unavailable levels are hidden. An upstream `ultra` effort is mapped to Pi's highest available level, `max`.

For example, after `/provider reload opencodex`, select a discovered reasoning model with a thinking suffix:

```text
/provider reload opencodex
# Then select: opencodex/gpt-5.6-sol:max
```

An endpoint must actually accept the OpenAI Chat Completions `reasoning_effort` request field. Providers that use a different thinking protocol (for example, Qwen's `enable_thinking`) are outside this extension's OpenAI-compatible transport scope.

## Stored configuration

Provider metadata and API keys are stored separately:

```text
~/.pi/agent/pi-provider-manager.json
~/.pi/agent/pi-provider-manager-secrets.json
```

The first file contains provider IDs, display names, and Base URLs. The second contains API keys. The extension creates its directory with `0700` permissions and the secrets file with `0600` permissions. API keys are not included in model-list output or notifications.

## Operational behavior

- Provider IDs are stable identifiers. `/provider edit` changes the display name, Base URL, and API key, but does not rename the provider ID.
- Cancelling the edit menu discards all unsaved changes.
- Saving an edit persists the new settings first, then refreshes that provider's model catalog. A failed catalog refresh does not discard an otherwise valid saved edit.
- `/provider list` reports the model count currently loaded in Pi. It can be `0` before a successful refresh.
- The extension starts by refreshing every managed provider with a 30-second timeout per refresh operation.

## Development

Install dependencies from the repository root:

```bash
npm install
```

Run only this local extension during development:

```bash
pi -ne -e .
```

For a single-file load:

```bash
pi -ne -e ./index.ts
```

After changing code, run `/reload` in Pi or restart Pi. To refresh model catalogs without reloading the extension, use:

```text
/provider reload --all
```

To register the package in Pi's user settings instead of passing `-e` every time:

```bash
pi install "$PWD"
```

## Security

Pi extensions can run with full system permissions. Review source code and packages before installing them.

Protect API keys, refresh tokens, custom authorization headers, and sensitive endpoint query parameters. The extension avoids printing raw API keys and sends only the credential required for model-list requests.

## License

Licensed under the [Apache License 2.0](LICENSE).
