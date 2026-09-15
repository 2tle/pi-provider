import type { RefreshModelsContext } from "@earendil-works/pi-ai";

export const API = "openai-completions" as const;
export const CODEX_API = "openai-responses" as const;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const REFRESH_TIMEOUT_MS = 30_000;
export const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface ModelOverride {
	contextWindow?: number;
	maxTokens?: number;
}

export interface StoredProvider {
	id: string;
	name: string;
	baseUrl: string;
	modelOverrides?: Record<string, ModelOverride>;
}

export interface StoredState {
	providers: StoredProvider[];
}

export interface StoredSecrets {
	apiKeys: Record<string, string>;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api: typeof API | typeof CODEX_API;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
	compat?: {
		supportsReasoningEffort: boolean;
	};
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

export interface ManagedProviderConfig {
	name: string;
	baseUrl: string;
	api: typeof API | typeof CODEX_API;
	apiKey: string;
	models: ProviderModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

export interface OpenAIModelPayload {
	id?: unknown;
	name?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	max_tokens?: unknown;
	maxTokens?: unknown;
	reasoning?: unknown;
	supports_reasoning?: unknown;
	supports_reasoning_effort?: unknown;
	reasoning_efforts?: unknown;
	supported_reasoning_levels?: unknown;
	input?: unknown;
	input_modalities?: unknown;
	cost?: unknown;
	capabilities?: unknown;
}

export interface OpenAIModelsPayload {
	data?: unknown;
	models?: unknown;
	list?: unknown;
}
