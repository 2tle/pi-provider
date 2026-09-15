import {
	API,
	CODEX_API,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	PI_THINKING_LEVELS,
	type OpenAIModelPayload,
	type ProviderModelConfig,
	type PiThinkingLevel,
	type StoredProvider,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function getReasoningEfforts(value: unknown): Set<string> {
	if (!Array.isArray(value)) return new Set();
	return new Set(value.flatMap((item) => {
		if (typeof item === "string") return [item.toLowerCase()];
		const record = asRecord(item);
		const effort = asNonEmptyString(record?.value ?? record?.effort);
		return effort ? [effort.toLowerCase()] : [];
	}));
}

function thinkingLevelMap(efforts: Set<string>): Partial<Record<PiThinkingLevel, string | null>> | undefined {
	if (efforts.size === 0) return undefined;
	const map: Partial<Record<PiThinkingLevel, string | null>> = {};
	for (const level of PI_THINKING_LEVELS) {
		if (efforts.has(level)) map[level] = level;
		else if (level === "max" && efforts.has("ultra")) map[level] = "ultra";
		else map[level] = null;
	}
	return map;
}

export function modelFromPayload(provider: StoredProvider, payload: OpenAIModelPayload): ProviderModelConfig | undefined {
	const id = asNonEmptyString(payload.id);
	if (!id) return undefined;

	const override = provider.modelOverrides?.[id];
	const capabilities = asRecord(payload.capabilities);
	const cost = asRecord(payload.cost);
	const inputModalities = Array.isArray(payload.input) ? payload.input : payload.input_modalities ?? capabilities?.input_modalities;
	const input: ("text" | "image")[] = Array.isArray(inputModalities) && inputModalities.includes("image")
		? ["text", "image"]
		: ["text"];
	const efforts = getReasoningEfforts(payload.reasoning_efforts ?? payload.supported_reasoning_levels ?? capabilities?.reasoning_effort);
	const reasoning = payload.reasoning === true || payload.supports_reasoning === true ||
		payload.supports_reasoning_effort === true || capabilities?.supports_reasoning === true || efforts.size > 0;

	const isCodex = provider.baseUrl.trim().replace(/\/+$/, "").endsWith("/codex");

	return {
		id,
		name: asNonEmptyString(payload.name) ?? id,
		api: isCodex ? CODEX_API : API,
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(efforts), compat: { supportsReasoningEffort: true } } : {}),
		input,
		cost: {
			input: asPositiveNumber(cost?.input, 0),
			output: asPositiveNumber(cost?.output, 0),
			cacheRead: asPositiveNumber(cost?.cacheRead, 0),
			cacheWrite: asPositiveNumber(cost?.cacheWrite, 0),
		},
		contextWindow: asPositiveNumber(override?.contextWindow, asPositiveNumber(
			payload.context_window ?? payload.contextWindow ?? capabilities?.context_length,
			DEFAULT_CONTEXT_WINDOW,
		)),
		maxTokens: asPositiveNumber(override?.maxTokens, asPositiveNumber(
			payload.max_tokens ?? payload.maxTokens ?? capabilities?.max_output_tokens,
			DEFAULT_MAX_TOKENS,
		)),
	};
}
