import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { DynamicBorder, keyHint, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, getKeybindings, Input, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-provider-manager.json");
const SECRETS_PATH = join(homedir(), ".pi", "agent", "pi-provider-manager-secrets.json");
const API = "openai-completions" as const;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const REFRESH_TIMEOUT_MS = 30_000;

interface StoredProvider {
	id: string;
	name: string;
	baseUrl: string;
}

interface StoredState {
	providers: StoredProvider[];
}

interface StoredSecrets {
	apiKeys: Record<string, string>;
}

interface ProviderModelConfig {
	id: string;
	name: string;
	api: typeof API;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

interface ManagedProviderConfig {
	name: string;
	baseUrl: string;
	api: typeof API;
	apiKey: string;
	models: ProviderModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

interface OpenAIModelPayload {
	id?: unknown;
	name?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	max_tokens?: unknown;
	maxTokens?: unknown;
	reasoning?: unknown;
	supports_reasoning?: unknown;
	input?: unknown;
	cost?: unknown;
}

interface OpenAIModelsPayload {
	data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function validateProviderId(id: string): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
		throw new Error("Provider ID may contain only lowercase letters, numbers, '.', '_' or '-'.");
	}
}

function validateBaseUrl(value: string): string {
	const baseUrl = normalizeBaseUrl(value);
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error("Base URL is not a valid URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Base URL must use the http or https protocol.");
	}
	return baseUrl;
}

function modelsUrl(baseUrl: string): string {
	return new URL("models", `${normalizeBaseUrl(baseUrl)}/`).toString();
}

async function loadState(): Promise<StoredState> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = asRecord(JSON.parse(raw));
		const providers = Array.isArray(parsed?.providers) ? parsed.providers : [];
		const normalized: StoredProvider[] = [];
		for (const item of providers) {
			const record = asRecord(item);
			const id = asNonEmptyString(record?.id);
			const name = asNonEmptyString(record?.name);
			const baseUrl = asNonEmptyString(record?.baseUrl);
			if (!id || !name || !baseUrl) continue;
			try {
				validateProviderId(id);
				normalized.push({ id, name, baseUrl: validateBaseUrl(baseUrl) });
			} catch {
				// Ignore malformed entries so one broken provider does not prevent startup.
			}
		}
		return { providers: normalized };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { providers: [] };
		}
		throw new Error(`Unable to read provider configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadSecrets(): Promise<StoredSecrets> {
	try {
		const raw = await readFile(SECRETS_PATH, "utf8");
		const parsed = asRecord(JSON.parse(raw));
		const apiKeys: Record<string, string> = {};
		const rawApiKeys = asRecord(parsed?.apiKeys);
		for (const [id, value] of Object.entries(rawApiKeys ?? {})) {
			if (typeof value === "string" && value.trim()) apiKeys[id] = value;
		}
		return { apiKeys };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { apiKeys: {} };
		}
		throw new Error(`Unable to read provider API keys: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveJsonFile(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	const content = `${JSON.stringify(value, null, 2)}\n`;
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

async function saveState(state: StoredState): Promise<void> {
	await saveJsonFile(CONFIG_PATH, state);
}

async function saveSecrets(secrets: StoredSecrets): Promise<void> {
	await saveJsonFile(SECRETS_PATH, secrets);
}

function modelFromPayload(
	provider: StoredProvider,
	payload: OpenAIModelPayload,
): ProviderModelConfig | undefined {
	const id = asNonEmptyString(payload.id);
	if (!id) return undefined;

	const cost = asRecord(payload.cost);
	const input: ("text" | "image")[] =
		Array.isArray(payload.input) && payload.input.includes("image") ? ["text", "image"] : ["text"];

	return {
		id,
		name: asNonEmptyString(payload.name) ?? id,
		api: API,
		reasoning: payload.reasoning === true || payload.supports_reasoning === true,
		input,
		cost: {
			input: asPositiveNumber(cost?.input, 0),
			output: asPositiveNumber(cost?.output, 0),
			cacheRead: asPositiveNumber(cost?.cacheRead, 0),
			cacheWrite: asPositiveNumber(cost?.cacheWrite, 0),
		},
		contextWindow: asPositiveNumber(payload.context_window ?? payload.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: asPositiveNumber(payload.max_tokens ?? payload.maxTokens, DEFAULT_MAX_TOKENS),
	};
}

async function fetchProviderModels(
	provider: StoredProvider,
	context: RefreshModelsContext,
	getApiKey: () => string | undefined,
): Promise<ProviderModelConfig[]> {
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error(`API key for provider '${provider.id}' is not configured.`);
	}

	const response = await fetch(modelsUrl(provider.baseUrl), {
		signal: context.signal,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch model list (${response.status} ${response.statusText})`);
	}

	const payload = (await response.json()) as OpenAIModelsPayload | unknown[];
	const data = Array.isArray(payload) ? payload : asRecord(payload)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Model list response does not contain a data array.");
	}

	return data
		.map((item) => {
			const record = asRecord(item);
			return record ? modelFromPayload(provider, record as OpenAIModelPayload) : undefined;
		})
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

function createManagedProvider(
	config: StoredProvider,
	getApiKey: () => string | undefined,
): ManagedProviderConfig {
	return {
		name: config.name,
		baseUrl: config.baseUrl,
		api: API,
		// The API key is held outside the regular provider config and is only
		// read when the provider is registered or refreshed.
		apiKey: getApiKey() ?? "local",
		models: [],
		refreshModels: (context) => fetchProviderModels(config, context, getApiKey),
	};
}

export function maskInputLine(line: string): string {
	const prompt = line.startsWith("> ") ? "> " : "";
	let result = "";
	for (let index = prompt.length; index < line.length; ) {
		// Keep Input's zero-width APC cursor marker intact. Masking only CSI/SGR
		// codes previously turned the marker bytes into visible bullets.
		if (line.startsWith(CURSOR_MARKER, index)) {
			result += CURSOR_MARKER;
			index += CURSOR_MARKER.length;
			continue;
		}

		if (line[index] === "\x1b") {
			const ansi = line.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)?.[0];
			if (ansi) {
				result += ansi;
				index += ansi.length;
				continue;
			}
		}

		const character = line[index++];
		result += /\s/u.test(character) ? character : "*";
	}
	return prompt + result;
}

class MaskedInput extends Input {
	override render(width: number): string[] {
		const terminalWidth = process.stdout.columns;
		const safeWidth = Math.max(1, Number.isFinite(terminalWidth) ? Math.min(width, terminalWidth) : width);
		return super.render(safeWidth).map((line) => truncateToWidth(maskInputLine(line), safeWidth, "", false));
	}
}

class SecretInputDialog extends Container {
	private readonly input = new MaskedInput();
	private _focused = false;

	constructor(
		done: (value: string | undefined) => void,
		title: string,
		helpText: string,
		border: (text: string) => string,
	) {
		super();
		// Match Pi's built-in ctx.ui.input() layout while keeping the secret masked.
		this.addChild(new DynamicBorder(border));
		this.addChild(new Spacer(1));
		this.addChild(new Text(title, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(helpText, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(border));
		this.done = done;
	}

	private readonly done: (value: string | undefined) => void;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.done(this.input.getValue());
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			this.input.handleInput(data);
		}
	}
}

function parseArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function usage(): string {
	return [
		"Usage:",
		"  /provider add",
		"  /provider list",
		"  /provider edit <provider_name>",
		"  /provider reload --all",
		"  /provider reload <provider_name>",
		"  /provider delete <provider_name>",
	].join("\n");
}

function commandNotify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function refreshProviders(
	ctx: ExtensionCommandContext,
	providerIds: readonly string[],
): Promise<void> {
	if (providerIds.length === 0) {
		commandNotify(ctx, "No providers to refresh.", "warning");
		return;
	}

	const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
	const result = await ctx.modelRegistry.refresh({
		providers: providerIds,
		allowNetwork: true,
		force: true,
		signal,
	});

	if (result.aborted) {
		throw new Error("Model list refresh was cancelled or timed out.");
	}

	const messages: string[] = [];
	for (const providerId of providerIds) {
		const error = result.errors.get(providerId);
		if (error) {
			messages.push(`${providerId}: failed — ${error.message}`);
			continue;
		}
		const provider = ctx.modelRegistry.getProvider(providerId);
		const count = provider?.getModels().length ?? 0;
		messages.push(`${providerId}: ${count} model${count === 1 ? "" : "s"}`);
	}

	const failed = result.errors.size > 0;
	commandNotify(ctx, `Model list refresh complete\n${messages.join("\n")}`, failed ? "warning" : "info");
}

async function promptForProvider(ctx: ExtensionCommandContext): Promise<StoredProvider | undefined> {
	if (!ctx.hasUI) throw new Error("/provider add requires an interactive UI.");

	const id = (await ctx.ui.input("Provider ID", "e.g. lmstudio"))?.trim();
	if (!id) return undefined;
	validateProviderId(id);

	const name = (await ctx.ui.input("Provider display name", id))?.trim() || id;
	const baseUrlInput = await ctx.ui.input("OpenAI-compatible Base URL", "e.g. http://localhost:1234/v1");
	if (!baseUrlInput?.trim()) return undefined;

	return { id, name, baseUrl: validateBaseUrl(baseUrlInput) };
}

async function promptForApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("API key entry requires an interactive UI.");

	const apiKey =
		ctx.mode === "tui"
			? await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) =>
				new SecretInputDialog(
					done,
					theme.fg("accent", "API key"),
					`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`,
					(text: string) => theme.fg("accent", text),
				),
			)
			: await ctx.ui.input("API key", "sk-... or local");

	if (apiKey === undefined) return undefined;
	if (!apiKey.trim()) throw new Error("API key cannot be empty.");
	return apiKey;
}

interface ProviderEdit {
	provider: StoredProvider;
	apiKey?: string;
}

async function promptForProviderEdit(
	ctx: ExtensionCommandContext,
	provider: StoredProvider,
): Promise<ProviderEdit | undefined> {
	if (!ctx.hasUI) throw new Error("/provider edit requires an interactive UI.");

	let updatedProvider = { ...provider };
	let updatedApiKey: string | undefined;

	while (true) {
		const choice = await ctx.ui.select(`Edit provider: ${provider.id}`, [
			`Change display name (${updatedProvider.name})`,
			`Change Base URL (${updatedProvider.baseUrl})`,
			"Change API key",
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
			const baseUrlInput = await ctx.ui.input("OpenAI-compatible Base URL", `Current value: ${updatedProvider.baseUrl}`);
			if (!baseUrlInput?.trim()) continue;
			try {
				updatedProvider = { ...updatedProvider, baseUrl: validateBaseUrl(baseUrlInput) };
			} catch (error) {
				commandNotify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}

		const apiKey = await promptForApiKey(ctx);
		if (apiKey !== undefined) updatedApiKey = apiKey;
	}
}

function findManagedProvider(managed: ReadonlyMap<string, StoredProvider>, name: string): StoredProvider | undefined {
	const providerById = managed.get(name);
	if (providerById) return providerById;

	const matches = [...managed.values()].filter((provider) => provider.name === name);
	if (matches.length > 1) {
		throw new Error(`Multiple providers have the display name '${name}'. Use a provider ID instead.`);
	}
	return matches[0];
}

function providerListMessage(
	providers: readonly StoredProvider[],
	secrets: StoredSecrets,
	ctx: ExtensionCommandContext,
): string {
	if (providers.length === 0) return "No managed providers.";

	return ["Managed providers:", ...providers.map((provider) => {
		const modelCount = ctx.modelRegistry.getProvider(provider.id)?.getModels().length ?? 0;
		const apiKeyStatus = secrets.apiKeys[provider.id] ? "configured" : "missing";
		return `- ${provider.id} (${provider.name})\n  Base URL: ${provider.baseUrl}\n  API key: ${apiKeyStatus} · Models: ${modelCount}`;
	})].join("\n");
}

export default async function (pi: ExtensionAPI) {
	const state = await loadState();
	const secrets = await loadSecrets();
	const managed = new Map<string, StoredProvider>();

	for (const provider of state.providers) {
		if (managed.has(provider.id)) continue;
		managed.set(provider.id, provider);
		pi.registerProvider(provider.id, createManagedProvider(provider, () => secrets.apiKeys[provider.id]));
	}

	pi.registerCommand("provider", {
		description: "Add, list, edit, refresh, and delete OpenAI-compatible providers",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = parseArgs(args);

				if (!subcommand) {
					commandNotify(ctx, usage(), "warning");
					return;
				}

				if (subcommand === "list") {
					if (rest.length > 0) throw new Error("/provider list does not accept arguments.");
					commandNotify(ctx, providerListMessage([...managed.values()], secrets, ctx));
					return;
				}

				if (subcommand === "add") {
					if (rest.length > 0) throw new Error("/provider add does not accept arguments.");
					const provider = await promptForProvider(ctx);
					if (!provider) return;
					if (managed.has(provider.id) || ctx.modelRegistry.getProvider(provider.id)) {
						throw new Error(`Provider '${provider.id}' is already registered.`);
					}
					const apiKey = await promptForApiKey(ctx);
					if (!apiKey) return;

					const nextState: StoredState = { providers: [...state.providers, provider] };
					const previousApiKey = secrets.apiKeys[provider.id];
					secrets.apiKeys[provider.id] = apiKey;
					try {
						await saveState(nextState);
						await saveSecrets(secrets);
						pi.registerProvider(provider.id, createManagedProvider(provider, () => secrets.apiKeys[provider.id]));
						state.providers = nextState.providers;
						managed.set(provider.id, provider);
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
					if (rest.length !== 1) throw new Error("Usage: /provider edit <provider_name>");
					const currentProvider = findManagedProvider(managed, rest[0]);
					if (!currentProvider) throw new Error(`Managed provider '${rest[0]}' was not found.`);

					const edit = await promptForProviderEdit(ctx, currentProvider);
					if (!edit) return;
					const providerChanged =
						edit.provider.name !== currentProvider.name || edit.provider.baseUrl !== currentProvider.baseUrl;
					if (!providerChanged && edit.apiKey === undefined) {
						commandNotify(ctx, "No provider settings were changed.", "warning");
						return;
					}

					const previousState: StoredState = { providers: [...state.providers] };
					const previousApiKey = secrets.apiKeys[currentProvider.id];
					const nextState: StoredState = {
						providers: state.providers.map((provider) =>
							provider.id === currentProvider.id ? edit.provider : provider,
						),
					};
					if (edit.apiKey !== undefined) secrets.apiKeys[currentProvider.id] = edit.apiKey;

					try {
						await saveState(nextState);
						if (edit.apiKey !== undefined) await saveSecrets(secrets);
						pi.registerProvider(
							currentProvider.id,
							createManagedProvider(edit.provider, () => secrets.apiKeys[currentProvider.id]),
						);
						state.providers = nextState.providers;
						managed.set(currentProvider.id, edit.provider);
					} catch (error) {
						if (previousApiKey === undefined) delete secrets.apiKeys[currentProvider.id];
						else secrets.apiKeys[currentProvider.id] = previousApiKey;
						await saveState(previousState).catch(() => undefined);
						if (edit.apiKey !== undefined) await saveSecrets(secrets).catch(() => undefined);
						pi.registerProvider(
							currentProvider.id,
							createManagedProvider(currentProvider, () => secrets.apiKeys[currentProvider.id]),
						);
						throw error;
					}

					commandNotify(ctx, `Saved settings for provider '${currentProvider.id}'. Fetching its model list.`);
					await refreshProviders(ctx, [currentProvider.id]);
					return;
				}

				if (subcommand === "reload") {
					if (rest.length !== 1) throw new Error("Usage: /provider reload --all | <provider_name>");
					const providerIds = rest[0] === "--all" ? [...managed.keys()] : [rest[0]];
					for (const providerId of providerIds) {
						if (!managed.has(providerId)) throw new Error(`Managed provider '${providerId}' was not found.`);
					}
					await refreshProviders(ctx, providerIds);
					return;
				}

				if (subcommand === "delete") {
					if (rest.length !== 1) throw new Error("Usage: /provider delete <provider_name>");
					const providerId = rest[0];
					if (!managed.has(providerId)) throw new Error(`Managed provider '${providerId}' was not found.`);
					if (!ctx.hasUI) throw new Error("/provider delete requires an interactive UI.");
					const shouldDelete = await ctx.ui.confirm(
						"Delete provider",
						`Delete provider '${providerId}' and its stored API key?`,
					);
					if (!shouldDelete) return;

					const previousState: StoredState = { providers: [...state.providers] };
					const previousApiKey = secrets.apiKeys[providerId];
					const nextState: StoredState = {
						providers: state.providers.filter((provider) => provider.id !== providerId),
					};
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
			} catch (error) {
				commandNotify(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (managed.size === 0) return;
		const result = await ctx.modelRegistry.refresh({
			providers: [...managed.keys()],
			allowNetwork: true,
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
		if (result.errors.size > 0 && ctx.hasUI) {
			ctx.ui.notify(`Could not refresh model lists for: ${[...result.errors.keys()].join(", ")}`, "warning");
		}
	});
}
