import type { PluginContext } from "emdash/plugin";

import { DEFAULT_ENDPOINT, isEndpoint, KEY_PATTERN } from "./indexnow";
import { joinUrl, originOf, parseCollections, parseRules } from "./urls";

/** Plugin settings, edited on the plugin's Settings page and stored with `ctx.settings`. */
export interface Settings {
	enabled: boolean;
	key: string;
	endpoint: string;
	/** Raw "Collections" text; `collections` is the parsed list (empty = all). */
	collectionsText: string;
	collections: string[];
	/** Absolute site URL used for submitted URLs; empty = EmDash's site URL. */
	siteUrl: string;
	/** "root" = `/{key}.txt` at the site root (recommended); "custom" = `keyLocationUrl`. */
	keyLocation: "root" | "custom";
	keyLocationUrl: string;
	urlRules: string;
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function loadSettings(ctx: PluginContext): Promise<Settings> {
	const [enabled, key, endpoint, collections, siteUrl, keyLocation, keyLocationUrl, urlRules] = await Promise.all(
		["enabled", "key", "endpoint", "collections", "siteUrl", "keyLocation", "keyLocationUrl", "urlRules"].map((name) =>
			ctx.settings.get<unknown>(name),
		),
	);
	const endpointHost = str(endpoint);
	const collectionsText = str(collections);
	return {
		enabled: enabled === true,
		key: str(key),
		endpoint: isEndpoint(endpointHost) ? endpointHost : DEFAULT_ENDPOINT,
		collectionsText,
		collections: parseCollections(collectionsText),
		siteUrl: str(siteUrl),
		keyLocation: keyLocation === "custom" ? "custom" : "root",
		keyLocationUrl: str(keyLocationUrl),
		urlRules: typeof urlRules === "string" ? urlRules : "",
	};
}

/** Validate a settings form. Returns the values to store, or the first problem. */
export function validateSettings(values: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
	const key = str(values.key);
	const siteUrl = str(values.siteUrl).replace(/\/+$/, "");
	const keyLocation = values.keyLocation === "custom" ? "custom" : "root";
	const keyLocationUrl = str(values.keyLocationUrl);
	const endpoint = str(values.endpoint) || DEFAULT_ENDPOINT;
	const urlRules = typeof values.urlRules === "string" ? values.urlRules : "";
	if (key && !KEY_PATTERN.test(key)) return { ok: false, error: "The key must be 8–128 characters: letters, digits and dashes." };
	if (siteUrl && !originOf(siteUrl)) return { ok: false, error: "Site URL must be an absolute http(s) URL, e.g. https://example.com." };
	if (keyLocation === "custom" && !originOf(keyLocationUrl)) return { ok: false, error: "Key file URL must be an absolute http(s) URL." };
	if (!isEndpoint(endpoint)) return { ok: false, error: "Unknown endpoint." };
	const { errors } = parseRules(urlRules);
	if (errors.length) return { ok: false, error: `URL rules: ${errors[0]}` };
	if (values.enabled === true && !key) return { ok: false, error: "Set or generate a key before enabling." };
	return {
		ok: true,
		values: {
			enabled: values.enabled === true,
			key,
			endpoint,
			collections: parseCollections(str(values.collections)).join(", "),
			siteUrl,
			keyLocation,
			keyLocationUrl,
			urlRules,
		},
	};
}

/** Origin of submitted URLs: the Site URL setting, else EmDash's site URL. */
export function siteOrigin(settings: Settings, ctx: Pick<PluginContext, "site">): string | null {
	return originOf(settings.siteUrl || ctx.site.url || "");
}

/** Where search engines fetch the key file to verify the host. */
export function keyFileUrl(settings: Settings, origin: string): string {
	return settings.keyLocation === "custom" && settings.keyLocationUrl ? settings.keyLocationUrl : joinUrl(origin, `/${settings.key}.txt`);
}

/** Why nothing would be submitted right now, or `null` when the plugin is ready. */
export function notReadyReason(settings: Settings, origin: string | null): string | null {
	if (!settings.enabled) return "IndexNow is turned off.";
	if (!settings.key) return "No key is set.";
	if (!origin) return "The site URL is unknown: set Site URL.";
	return null;
}
