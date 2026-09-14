import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { StoredProvider, StoredSecrets, StoredState } from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-provider-manager.json");
const SECRETS_PATH = join(homedir(), ".pi", "agent", "pi-provider-manager-secrets.json");

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeModelOverrides(value: unknown): StoredProvider["modelOverrides"] {
	const overrides: NonNullable<StoredProvider["modelOverrides"]> = {};
	for (const [modelId, rawOverride] of Object.entries(asRecord(value) ?? {})) {
		const override = asRecord(rawOverride);
		const contextWindow = asPositiveSafeInteger(override?.contextWindow);
		const maxTokens = asPositiveSafeInteger(override?.maxTokens);
		if (contextWindow !== undefined || maxTokens !== undefined) {
			overrides[modelId] = {
				...(contextWindow !== undefined ? { contextWindow } : {}),
				...(maxTokens !== undefined ? { maxTokens } : {}),
			};
		}
	}
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function validateProviderId(id: string): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
		throw new Error("Provider ID may contain only lowercase letters, numbers, '.', '_' or '-'.");
	}
}

export function validateBaseUrl(value: string): string {
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

export async function loadState(): Promise<StoredState> {
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
				const modelOverrides = normalizeModelOverrides(record?.modelOverrides);
				normalized.push({ id, name, baseUrl: validateBaseUrl(baseUrl), ...(modelOverrides ? { modelOverrides } : {}) });
			} catch {
				// Ignore malformed entries so one broken provider does not prevent startup.
			}
		}
		return { providers: normalized };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { providers: [] };
		throw new Error(`Unable to read provider configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function loadSecrets(): Promise<StoredSecrets> {
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
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { apiKeys: {} };
		throw new Error(`Unable to read provider API keys: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveJsonFile(path: string, value: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

export const saveState = (state: StoredState): Promise<void> => saveJsonFile(CONFIG_PATH, state);
export const saveSecrets = (secrets: StoredSecrets): Promise<void> => saveJsonFile(SECRETS_PATH, secrets);
