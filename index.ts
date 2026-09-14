import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { loadSecrets, loadState, saveSecrets, saveState, validateBaseUrl, validateProviderId } from "./src/config.js";
import { createManagedProvider } from "./src/provider.js";
import { SecretInputDialog } from "./src/ui.js";
import { REFRESH_TIMEOUT_MS, type StoredProvider, type StoredSecrets, type StoredState } from "./src/types.js";

// Preserve the helper's existing public export for consumers and tests.
export { maskInputLine } from "./src/ui.js";

function parseArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function formatTokenCount(value: number | undefined): string {
	return value === undefined ? "API/default" : value.toLocaleString();
}

function parseTokenCount(value: string): number | undefined {
	const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m|b)?$/);
	if (!match) return undefined;
	const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
	const parsed = Number(match[1]) * multiplier;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function providerChoiceLabel(provider: StoredProvider, ctx: ExtensionCommandContext): string {
	const modelCount = ctx.modelRegistry.getProvider(provider.id)?.getModels().length ?? 0;
	const overrideCount = Object.keys(provider.modelOverrides ?? {}).length;
	return `${provider.id} — ${provider.name} · ${modelCount} models · ${overrideCount} overrides`;
}

async function chooseManagedProvider(
	ctx: ExtensionCommandContext,
	managed: ReadonlyMap<string, StoredProvider>,
	action: string,
): Promise<StoredProvider | undefined> {
	if (!ctx.hasUI) throw new Error(`${action} requires an interactive UI.`);
	const providers = [...managed.values()].sort((a, b) => a.id.localeCompare(b.id));
	if (providers.length === 0) throw new Error("No managed providers.");
	const labels = providers.map((provider) => providerChoiceLabel(provider, ctx));
	const selected = await ctx.ui.select(action, labels);
	if (selected === undefined) return undefined;
	return providers[labels.indexOf(selected)];
}

function usage(): string {
	return [
		"Usage:",
		"  /provider add",
		"  /provider list",
		"  /provider edit [provider_name]",
		"  /provider model [provider_name] [model_id]",
		"  /provider reload --all",
		"  /provider reload <provider_name>",
		"  /provider delete <provider_name>",
	].join("\n");
}

function commandNotify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function refreshProviders(ctx: ExtensionCommandContext, providerIds: readonly string[]): Promise<void> {
	if (providerIds.length === 0) {
		commandNotify(ctx, "No providers to refresh.", "warning");
		return;
	}
	const result = await ctx.modelRegistry.refresh({
		providers: providerIds,
		allowNetwork: true,
		force: true,
		signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
	});
	if (result.aborted) throw new Error("Model list refresh was cancelled or timed out.");

	const messages = providerIds.map((providerId) => {
		const error = result.errors.get(providerId);
		if (error) return `${providerId}: failed — ${error.message}`;
		const count = ctx.modelRegistry.getProvider(providerId)?.getModels().length ?? 0;
		return `${providerId}: ${count} model${count === 1 ? "" : "s"}`;
	});
	commandNotify(ctx, `Model list refresh complete\n${messages.join("\n")}`, result.errors.size > 0 ? "warning" : "info");
}

async function promptForProvider(ctx: ExtensionCommandContext): Promise<StoredProvider | undefined> {
	if (!ctx.hasUI) throw new Error("/provider add requires an interactive UI.");
	const id = (await ctx.ui.input("Provider ID", "e.g. lmstudio"))?.trim();
	if (!id) return undefined;
	validateProviderId(id);
	const name = (await ctx.ui.input("Provider display name", id))?.trim() || id;
	const baseUrl = await ctx.ui.input("OpenAI-compatible Base URL", "e.g. http://localhost:1234/v1");
	if (!baseUrl?.trim()) return undefined;
	return { id, name, baseUrl: validateBaseUrl(baseUrl) };
}

async function promptForApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("API key entry requires an interactive UI.");
	const apiKey = ctx.mode === "tui"
		? await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => new SecretInputDialog(
			done,
			theme.fg("accent", "API key"),
			`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`,
			(text: string) => theme.fg("accent", text),
		))
		: await ctx.ui.input("API key", "sk-... or local");
	if (apiKey === undefined) return undefined;
	if (!apiKey.trim()) throw new Error("API key cannot be empty.");
	return apiKey;
}

async function promptForProviderEdit(ctx: ExtensionCommandContext, provider: StoredProvider): Promise<{ provider: StoredProvider; apiKey?: string } | undefined> {
	if (!ctx.hasUI) throw new Error("/provider edit requires an interactive UI.");
	let updatedProvider = { ...provider };
	let updatedApiKey: string | undefined;
	while (true) {
		const choice = await ctx.ui.select(`Edit provider: ${provider.id}`, [
			`Change display name (${updatedProvider.name})`,
			`Change Base URL (${updatedProvider.baseUrl})`,
			"Change API key",
			"Edit model limits",
			`Reset all model limits (${Object.keys(updatedProvider.modelOverrides ?? {}).length})`,
			"Save changes",
		]);
		if (choice === undefined) return undefined;
		if (choice === "Save changes") return { provider: updatedProvider, apiKey: updatedApiKey };
		if (choice.startsWith("Change display name")) {
			const name = await ctx.ui.input("Provider display name", `Current value: ${updatedProvider.name}`);
			if (name?.trim()) updatedProvider = { ...updatedProvider, name: name.trim() };
			continue;
		}
		if (choice.startsWith("Change Base URL")) {
			const baseUrl = await ctx.ui.input("OpenAI-compatible Base URL", `Current value: ${updatedProvider.baseUrl}`);
			if (!baseUrl?.trim()) continue;
			try { updatedProvider = { ...updatedProvider, baseUrl: validateBaseUrl(baseUrl) }; }
			catch (error) { commandNotify(ctx, error instanceof Error ? error.message : String(error), "error"); }
			continue;
		}
		if (choice === "Edit model limits") {
			const edited = await promptForModelOverride(ctx, updatedProvider);
			if (edited) updatedProvider = edited;
			continue;
		}
		if (choice.startsWith("Reset all model limits")) {
			if (Object.keys(updatedProvider.modelOverrides ?? {}).length === 0) continue;
			if (await ctx.ui.confirm("Reset model limits", `Remove all model overrides for '${provider.id}'?`)) {
				const { modelOverrides: _old, ...withoutOverrides } = updatedProvider;
				updatedProvider = withoutOverrides;
			}
			continue;
		}
		const apiKey = await promptForApiKey(ctx);
		if (apiKey !== undefined) updatedApiKey = apiKey;
	}
}

async function promptForModelOverride(
	ctx: ExtensionCommandContext,
	provider: StoredProvider,
	requestedModelId?: string,
): Promise<StoredProvider | undefined> {
	if (!ctx.hasUI) throw new Error("/provider model requires an interactive UI.");
	const loadedModels = ctx.modelRegistry.getProvider(provider.id)?.getModels() ?? [];
	const modelIds = new Set([...loadedModels.map((model) => model.id), ...Object.keys(provider.modelOverrides ?? {})]);
	let modelId = requestedModelId;
	if (!modelId) {
		const modelChoices = [...modelIds].sort().map((id) => {
			const model = loadedModels.find((item) => item.id === id);
			const override = provider.modelOverrides?.[id];
			const context = override?.contextWindow ?? model?.contextWindow;
			const output = override?.maxTokens ?? model?.maxTokens;
			const marker = override ? " · override" : "";
			return `${id} · context ${formatTokenCount(context)} · output ${formatTokenCount(output)}${marker}`;
		});
		const enterModelId = "Enter a model ID…";
		const selected = await ctx.ui.select(`Update model limits: ${provider.id}`, [...modelChoices, enterModelId]);
		if (selected === undefined) return undefined;
		modelId = selected === enterModelId
			? (await ctx.ui.input("Model ID", "e.g. opencode-go/deepseek-v4.1-flash"))?.trim()
			: [...modelIds].sort()[modelChoices.indexOf(selected)];
	}
	if (!modelId) return undefined;

	const modelOverrides = { ...provider.modelOverrides };
	let override = { ...modelOverrides[modelId] };
	while (true) {
		const choice = await ctx.ui.select(`Model limits: ${provider.id}/${modelId}`, [
			`Context window: ${formatTokenCount(override.contextWindow)}`,
			`Max output tokens: ${formatTokenCount(override.maxTokens)}`,
			"Clear context window override",
			"Clear max output override",
			"Remove all overrides for this model",
			"Save changes",
		]);
		if (choice === undefined) return undefined;
		if (choice === "Save changes") {
			if (override.contextWindow === undefined && override.maxTokens === undefined) delete modelOverrides[modelId];
			else modelOverrides[modelId] = override;
			const { modelOverrides: _old, ...providerWithoutOverrides } = provider;
			return { ...providerWithoutOverrides, ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}) };
		}
		if (choice === "Clear context window override") { const { contextWindow: _old, ...rest } = override; override = rest; continue; }
		if (choice === "Clear max output override") { const { maxTokens: _old, ...rest } = override; override = rest; continue; }
		if (choice === "Remove all overrides for this model") { override = {}; continue; }
		const field = choice.startsWith("Context window") ? "contextWindow" : "maxTokens";
		const label = field === "contextWindow" ? "Context window" : "Max output tokens";
		const input = await ctx.ui.input(label, "Examples: 128k, 1m, 1048576");
		if (input === undefined) continue;
		const value = parseTokenCount(input);
		if (value === undefined) { commandNotify(ctx, `${label} must be a positive whole token count (e.g. 128k or 1m).`, "error"); continue; }
		override = { ...override, [field]: value };
	}
}

function findManagedProvider(managed: ReadonlyMap<string, StoredProvider>, name: string): StoredProvider | undefined {
	const provider = managed.get(name);
	if (provider) return provider;
	const matches = [...managed.values()].filter((item) => item.name === name);
	if (matches.length > 1) throw new Error(`Multiple providers have the display name '${name}'. Use a provider ID instead.`);
	return matches[0];
}

function providerListMessage(providers: readonly StoredProvider[], secrets: StoredSecrets, ctx: ExtensionCommandContext): string {
	if (providers.length === 0) return "No managed providers.";
	return ["Managed providers:", ...providers.map((provider) => {
		const modelCount = ctx.modelRegistry.getProvider(provider.id)?.getModels().length ?? 0;
		const apiKeyStatus = secrets.apiKeys[provider.id] ? "configured" : "missing";
		const overrideCount = Object.keys(provider.modelOverrides ?? {}).length;
		return `- ${provider.id} (${provider.name})\n  Base URL: ${provider.baseUrl}\n  API key: ${apiKeyStatus} · Models: ${modelCount} · Overrides: ${overrideCount}`;
	})].join("\n");
}

export default async function (pi: ExtensionAPI) {
	const state = await loadState();
	const secrets = await loadSecrets();
	const managed = new Map<string, StoredProvider>();
	const register = (provider: StoredProvider) => {
		managed.set(provider.id, provider);
		pi.registerProvider(provider.id, createManagedProvider(provider, () => secrets.apiKeys[provider.id]));
	};
	for (const provider of state.providers) if (!managed.has(provider.id)) register(provider);

	pi.registerCommand("provider", {
		description: "Add, configure models, refresh, and delete OpenAI-compatible providers",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = parseArgs(args);
				if (!subcommand) { commandNotify(ctx, usage(), "warning"); return; }
				if (subcommand === "list") {
					if (rest.length) throw new Error("/provider list does not accept arguments.");
					commandNotify(ctx, providerListMessage([...managed.values()], secrets, ctx));
					return;
				}
				if (subcommand === "add") {
					if (rest.length) throw new Error("/provider add does not accept arguments.");
					const provider = await promptForProvider(ctx);
					if (!provider) return;
					if (managed.has(provider.id) || ctx.modelRegistry.getProvider(provider.id)) throw new Error(`Provider '${provider.id}' is already registered.`);
					const apiKey = await promptForApiKey(ctx);
					if (!apiKey) return;
					const nextState: StoredState = { providers: [...state.providers, provider] };
					const previousApiKey = secrets.apiKeys[provider.id];
					secrets.apiKeys[provider.id] = apiKey;
					try {
						await saveState(nextState);
						await saveSecrets(secrets);
						state.providers = nextState.providers;
						register(provider);
					} catch (error) {
						if (previousApiKey === undefined) delete secrets.apiKeys[provider.id];
						else secrets.apiKeys[provider.id] = previousApiKey;
						await saveState({ providers: state.providers }).catch(() => undefined);
						await saveSecrets(secrets).catch(() => undefined);
						pi.unregisterProvider(provider.id);
						throw error;
					}
					commandNotify(ctx, `Provider '${provider.id}' was added. Fetching its model list.`);
					await refreshProviders(ctx, [provider.id]);
					return;
				}
				if (subcommand === "edit") {
					if (rest.length > 1) throw new Error("Usage: /provider edit [provider_name]");
					const current = rest.length === 1
						? findManagedProvider(managed, rest[0])
						: await chooseManagedProvider(ctx, managed, "Edit provider");
					if (!current) return;
					const edit = await promptForProviderEdit(ctx, current); if (!edit) return;
					if (edit.provider.name === current.name && edit.provider.baseUrl === current.baseUrl && edit.apiKey === undefined) { commandNotify(ctx, "No provider settings were changed.", "warning"); return; }
					const previousState: StoredState = { providers: [...state.providers] };
					const previousApiKey = secrets.apiKeys[current.id];
					const nextState: StoredState = { providers: state.providers.map((item) => item.id === current.id ? edit.provider : item) };
					if (edit.apiKey !== undefined) secrets.apiKeys[current.id] = edit.apiKey;
					try {
						await saveState(nextState);
						if (edit.apiKey !== undefined) await saveSecrets(secrets);
						state.providers = nextState.providers;
						register(edit.provider);
					} catch (error) {
						if (previousApiKey === undefined) delete secrets.apiKeys[current.id];
						else secrets.apiKeys[current.id] = previousApiKey;
						await saveState(previousState).catch(() => undefined);
						if (edit.apiKey !== undefined) await saveSecrets(secrets).catch(() => undefined);
						register(current);
						throw error;
					}
					commandNotify(ctx, `Saved settings for provider '${current.id}'. Fetching its model list.`);
					await refreshProviders(ctx, [current.id]);
					return;
				}
				if (subcommand === "model") {
					if (rest.length > 2) throw new Error("Usage: /provider model [provider_name] [model_id]");
					const current = rest.length > 0
						? findManagedProvider(managed, rest[0])
						: await chooseManagedProvider(ctx, managed, "Edit model limits");
					if (!current) return;
					const updated = await promptForModelOverride(ctx, current, rest[1]); if (!updated) return;
					const previousState: StoredState = { providers: [...state.providers] };
					const nextState: StoredState = { providers: state.providers.map((item) => item.id === current.id ? updated : item) };
					try {
						await saveState(nextState);
						state.providers = nextState.providers;
						register(updated);
					} catch (error) {
						await saveState(previousState).catch(() => undefined);
						register(current);
						throw error;
					}
					commandNotify(ctx, `Saved model config overrides for provider '${current.id}'. Fetching its model list.`);
					await refreshProviders(ctx, [current.id]);
					return;
				}
				if (subcommand === "reload") {
					if (rest.length !== 1) throw new Error("Usage: /provider reload --all | <provider_name>");
					const ids = rest[0] === "--all" ? [...managed.keys()] : [rest[0]];
					for (const id of ids) if (!managed.has(id)) throw new Error(`Managed provider '${id}' was not found.`);
					await refreshProviders(ctx, ids); return;
				}
				if (subcommand === "delete") {
					if (rest.length !== 1) throw new Error("Usage: /provider delete <provider_name>");
					const providerId = rest[0];
					if (!managed.has(providerId)) throw new Error(`Managed provider '${providerId}' was not found.`);
					if (!ctx.hasUI) throw new Error("/provider delete requires an interactive UI.");
					if (!await ctx.ui.confirm("Delete provider", `Delete provider '${providerId}' and its stored API key?`)) return;
					const previousState: StoredState = { providers: [...state.providers] };
					const previousApiKey = secrets.apiKeys[providerId];
					const nextState: StoredState = { providers: state.providers.filter((item) => item.id !== providerId) };
					delete secrets.apiKeys[providerId];
					try {
						await saveState(nextState);
						await saveSecrets(secrets);
						pi.unregisterProvider(providerId);
						managed.delete(providerId);
						state.providers = nextState.providers;
					} catch (error) {
						if (previousApiKey !== undefined) secrets.apiKeys[providerId] = previousApiKey;
						await saveState(previousState).catch(() => undefined);
						await saveSecrets(secrets).catch(() => undefined);
						throw error;
					}
					commandNotify(ctx, `Provider '${providerId}' was deleted.`);
					return;
				}
				throw new Error(`Unknown provider command: ${subcommand}\n\n${usage()}`);
			} catch (error) { commandNotify(ctx, error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (managed.size === 0) return;
		const result = await ctx.modelRegistry.refresh({ providers: [...managed.keys()], allowNetwork: true, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
		if (result.errors.size > 0 && ctx.hasUI) ctx.ui.notify(`Could not refresh model lists for: ${[...result.errors.keys()].join(", ")}`, "warning");
	});
}
