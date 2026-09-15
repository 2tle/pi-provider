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

function isCodexBaseUrl(baseUrl: string): boolean {
	const normalized = normalizeBaseUrl(baseUrl);
	// Official Codex uses /backend-api/codex/*, while some gateways expose
	// the /codex prefix directly. In both cases pi-ai's Codex transport is
	// required; otherwise it POSTs /chat/completions and receives 405.
	return normalized.endsWith("/codex") || normalized.endsWith("/codex/responses") || normalized.endsWith("/backend-api");
}

function codexResourceBaseUrl(baseUrl: string): string {
	const normalized = normalizeBaseUrl(baseUrl);
	if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
	if (normalized.endsWith("/backend-api")) return `${normalized}/codex`;
	return normalized;
}

function modelsUrl(baseUrl: string): string {
	return new URL("models", `${codexResourceBaseUrl(baseUrl)}/`).toString();
}

function describeResponseBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "<empty body>";
	return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed;
}

export async function fetchProviderModels(
	provider: StoredProvider,
	context: RefreshModelsContext,
	getApiKey: () => string | undefined,
): Promise<ProviderModelConfig[]> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error(`API key for provider '${provider.id}' is not configured.`);
	const url = modelsUrl(provider.baseUrl);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			signal: context.signal,
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
		});
	} catch (error) {
		throw new Error(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`GET ${url} failed (${response.status} ${response.statusText}): ${describeResponseBody(responseBody)}`);
	}

	let payload: OpenAIModelsPayload | unknown[];
	try {
		payload = JSON.parse(responseBody) as OpenAIModelsPayload | unknown[];
	} catch (error) {
		throw new Error(`GET ${url} returned invalid JSON: ${describeResponseBody(responseBody)}`, { cause: error });
	}
	// OpenAI uses data, while Codex gateways commonly return models or list.
	const data = Array.isArray(payload)
		? payload
		: asRecord(payload)?.data ?? asRecord(payload)?.models ?? asRecord(payload)?.list;
	if (!Array.isArray(data)) throw new Error(`GET ${url} response does not contain a data/models/list array: ${describeResponseBody(responseBody)}`);
	return data.map((item) => {
		const record = asRecord(item);
		if (!record) return undefined;
		// Codex's catalog uses slug/display_name instead of OpenAI's id/name.
		const normalized: OpenAIModelPayload = isCodexBaseUrl(provider.baseUrl)
			? { ...record, id: record.id ?? record.slug, name: record.name ?? record.display_name }
			: record;
		return modelFromPayload(provider, normalized);
	}).filter((model): model is ProviderModelConfig => model !== undefined);
}

export function createManagedProvider(
	config: StoredProvider,
	getApiKey: () => string | undefined,
): ManagedProviderConfig {
	const isCodex = isCodexBaseUrl(config.baseUrl);
	return {
		name: config.name,
		baseUrl: isCodex ? codexResourceBaseUrl(config.baseUrl) : config.baseUrl,
		// API-key Codex gateways expose the standard Responses protocol. The
		// ChatGPT Codex transport expects an OAuth JWT account claim and is not
		// suitable here; completions would POST /chat/completions and get 405.
		api: isCodex ? CODEX_API : "openai-completions",
		apiKey: getApiKey() ?? "local",
		models: [],
		refreshModels: (context) => fetchProviderModels(config, context, getApiKey),
	};
}
