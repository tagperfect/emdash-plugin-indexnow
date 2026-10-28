/**
 * The IndexNow protocol (https://www.indexnow.org/documentation): endpoints, key format, request body
 * and the meaning of each response status. Pure, no host calls.
 */

/** Every host here must also be listed in `allowedHosts` of emdash-plugin.jsonc. */
export const ENDPOINTS = [
	{ host: "api.indexnow.org", label: "api.indexnow.org (shared by all engines)" },
	{ host: "www.bing.com", label: "Bing" },
	{ host: "yandex.com", label: "Yandex" },
	{ host: "search.seznam.cz", label: "Seznam" },
	{ host: "searchadvisor.naver.com", label: "Naver" },
	{ host: "indexnow.yep.com", label: "Yep" },
] as const;

export const DEFAULT_ENDPOINT = "api.indexnow.org";

/** Protocol limit per POST. */
export const MAX_URLS_PER_REQUEST = 10_000;

/** 8–128 characters: letters, digits and dashes. */
export const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export function isEndpoint(host: string): boolean {
	return ENDPOINTS.some((endpoint) => endpoint.host === host);
}

export function endpointUrl(host: string): string {
	return `https://${host}/indexnow`;
}

/** 32 hexadecimal characters. */
export function generateKey(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

export interface SubmitBody {
	host: string;
	key: string;
	keyLocation: string;
	urlList: string[];
}

export function requestBody(host: string, key: string, keyLocation: string, urlList: string[]): SubmitBody {
	return { host, key, keyLocation, urlList };
}

export function chunk<T>(items: T[], size = MAX_URLS_PER_REQUEST): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export interface Outcome {
	/** HTTP status; 0 when the request never got a response. */
	status: number;
	ok: boolean;
	/** Worth sending again later (rate limit, server or network error). */
	retry: boolean;
	/** The key or the site setup is wrong: retrying does not help until settings change. */
	setupProblem: boolean;
	message: string;
}

const MESSAGES: Record<number, Omit<Outcome, "status">> = {
	200: { ok: true, retry: false, setupProblem: false, message: "Submitted." },
	202: { ok: true, retry: false, setupProblem: false, message: "Accepted; key validation pending." },
	400: { ok: false, retry: false, setupProblem: false, message: "Bad request: the request format is invalid." },
	403: {
		ok: false,
		retry: false,
		setupProblem: true,
		message: "Key not valid: the key file was not found at keyLocation or does not contain the key.",
	},
	422: {
		ok: false,
		retry: false,
		setupProblem: true,
		message: "Unprocessable: the URLs do not belong to the host, or the key does not match the protocol format.",
	},
	429: { ok: false, retry: true, setupProblem: false, message: "Too many requests: rate limited, will retry later." },
};

/** Translate a response into a log line. The response body, if any, is appended (trimmed). */
export function interpret(status: number, body = ""): Outcome {
	const known = MESSAGES[status];
	let outcome: Omit<Outcome, "status">;
	if (known) outcome = known;
	else if (status === 0) outcome = { ok: false, retry: true, setupProblem: false, message: "Network error: no response, will retry later." };
	else if (status >= 500) outcome = { ok: false, retry: true, setupProblem: false, message: `Search engine error ${status}, will retry later.` };
	else if (status >= 200 && status < 300) outcome = { ok: true, retry: false, setupProblem: false, message: `Accepted (${status}).` };
	else outcome = { ok: false, retry: false, setupProblem: false, message: `Unexpected response ${status}.` };
	const detail = outcome.ok ? "" : body.replace(/\s+/g, " ").trim().slice(0, 200);
	return { status, ...outcome, message: detail ? `${outcome.message} ${detail}` : outcome.message };
}
