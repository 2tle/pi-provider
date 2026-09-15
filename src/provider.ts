import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { modelFromPayload } from "./models.js";
import { CODEX_API } from "./types.js";
import type { ManagedProviderConfig, OpenAIModelsPayload, OpenAIModelPayload, ProviderModelConfig, StoredProvider } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function modelsUrl(baseUrl: string): string {
	return new URL("models", `${normalizeBaseUrl(baseUrl)}/`).toString();
}

export async function fetchProviderModels(
	provider: StoredProvider,
	context: RefreshModelsContext,
	getApiKey: () => string | undefined,
): Promise<ProviderModelConfig[]> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error(`API key for provider '${provider.id}' is not configured.`);
	const response = await fetch(modelsUrl(provider.baseUrl), {
		signal: context.signal,
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) throw new Error(`Failed to fetch model list (${response.status} ${response.statusText})`);

	const payload = (await response.json()) as OpenAIModelsPayload | unknown[];
	const data = Array.isArray(payload) ? payload : asRecord(payload)?.data ?? asRecord(payload)?.models;
	if (!Array.isArray(data)) throw new Error("Model list response does not contain a data/models array.");
	return data.map((item) => {
		const record = asRecord(item);
		if (!record) return undefined;
		// Codex's catalog uses slug/display_name instead of OpenAI's id/name.
		const normalized: OpenAIModelPayload = provider.baseUrl.trim().replace(/\/+$/, "").endsWith("/codex")
			? { ...record, id: record.id ?? record.slug, name: record.name ?? record.display_name }
			: record;
		return modelFromPayload(provider, normalized);
	}).filter((model): model is ProviderModelConfig => model !== undefined);
}

export function createManagedProvider(
	config: StoredProvider,
	getApiKey: () => string | undefined,
): ManagedProviderConfig {
	const isCodex = config.baseUrl.trim().replace(/\/+$/, "").endsWith("/codex");
	return {
		name: config.name,
		baseUrl: config.baseUrl,
		// Codex gateways expose Responses at /codex/responses; using the
		// completions transport would POST /codex/chat/completions (405).
		api: isCodex ? CODEX_API : "openai-completions",
		apiKey: getApiKey() ?? "local",
		models: [],
		refreshModels: (context) => fetchProviderModels(config, context, getApiKey),
	};
}
