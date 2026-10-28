/**
 * URL building for IndexNow: URL rules, placeholder filling, indexability and de-duplication.
 * Pure functions, no host calls, so they are unit-tested directly.
 */

/** The parts of a content entry the URL logic reads. */
export interface EntryRef {
	collection: string;
	id: string;
	slug: string | null;
	locale: string | null;
	status: string;
	data: Record<string, unknown>;
	seo?: { noIndex?: boolean | null } | null;
}

type Condition = { field: string; op: "eq" | "neq"; value: string } | { field: string; op: "set" | "unset" };

/**
 * One URL rule: `<collection> <locale|*> <pattern|-> [conditions…]`.
 * A `null` pattern (written `-`) means "this entry has no page": nothing is submitted for it.
 */
export interface UrlRule {
	collection: string;
	locale: string;
	pattern: string | null;
	conditions: Condition[];
	line: number;
}

const FIELD = /^[A-Za-z_]\w*$/;
const PLACEHOLDER = /\{(slug|id|locale)\}/g;

function parseCondition(token: string): Condition | null {
	const compare = /^([A-Za-z_]\w*)(!=|=)(.*)$/.exec(token);
	if (compare) return { field: compare[1]!, op: compare[2] === "=" ? "eq" : "neq", value: compare[3]! };
	const presence = /^(!?)([A-Za-z_]\w*)$/.exec(token);
	if (presence) return { field: presence[2]!, op: presence[1] ? "unset" : "set" };
	return null;
}

/** Parse the "URL rules" setting. Blank lines and `#` comments are ignored; bad lines are reported, not applied. */
export function parseRules(text: string): { rules: UrlRule[]; errors: string[] } {
	const rules: UrlRule[] = [];
	const errors: string[] = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = index + 1;
		const body = raw.trim();
		if (!body || body.startsWith("#")) return;
		const [collection, locale, pattern, ...tokens] = body.split(/\s+/);
		if (!collection || !locale || !pattern) {
			errors.push(`Line ${line}: expected "<collection> <locale|*> <pattern|->".`);
			return;
		}
		if (!FIELD.test(collection)) {
			errors.push(`Line ${line}: "${collection}" is not a collection slug.`);
			return;
		}
		if (pattern !== "-" && !pattern.startsWith("/")) {
			errors.push(`Line ${line}: the pattern must start with "/" or be "-".`);
			return;
		}
		const conditions: Condition[] = [];
		for (const token of tokens) {
			const condition = parseCondition(token);
			if (!condition) {
				errors.push(`Line ${line}: "${token}" is not a condition (field=value, field!=value, field, !field).`);
				return;
			}
			conditions.push(condition);
		}
		rules.push({ collection, locale, pattern: pattern === "-" ? null : pattern, conditions, line });
	});
	return { rules, errors };
}

const scalar = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

function fieldValue(entry: EntryRef, field: string): string {
	if (field === "slug") return entry.slug ?? "";
	if (field === "locale") return entry.locale ?? "";
	if (field === "id") return entry.id;
	return scalar(entry.data[field]);
}

function holds(condition: Condition, entry: EntryRef): boolean {
	const value = fieldValue(entry, condition.field);
	switch (condition.op) {
		case "eq":
			return value === condition.value;
		case "neq":
			return value !== condition.value;
		case "set":
			return value !== "" && value !== "false";
		case "unset":
			return value === "" || value === "false";
	}
}

/** First rule (top to bottom) for the entry's collection and locale whose conditions all hold. */
export function findRule(rules: UrlRule[], entry: EntryRef): UrlRule | undefined {
	return rules.find(
		(rule) =>
			rule.collection === entry.collection &&
			(rule.locale === "*" || rule.locale === (entry.locale ?? "")) &&
			rule.conditions.every((condition) => holds(condition, entry)),
	);
}

/** Fill `{slug}`, `{id}`, `{locale}`; `null` when a placeholder has no value (e.g. an entry without a slug). */
export function fillPattern(pattern: string, entry: EntryRef): string | null {
	let missing = false;
	const path = pattern.replace(PLACEHOLDER, (_, name: string) => {
		const value = name === "slug" ? entry.slug : name === "id" ? entry.id : entry.locale;
		if (!value) missing = true;
		return encodeURIComponent(value ?? "");
	});
	return missing ? null : path;
}

/** `https://host` (no trailing slash) of an absolute http(s) URL, or `null`. */
export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
	} catch {
		return null;
	}
}

export function joinUrl(origin: string, path: string): string {
	return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Move an absolute URL onto another origin, keeping path and query (getPublicUrl uses the host's site URL). */
export function rebase(url: string, origin: string): string {
	const parsed = new URL(url);
	return joinUrl(origin, `${parsed.pathname}${parsed.search}`);
}

export type Indexability = "ok" | "draft" | "noindex";

/** Only live entries that are not hidden from search engines are submitted. */
export function indexability(entry: Pick<EntryRef, "status" | "seo">): Indexability {
	if (entry.status !== "published") return "draft";
	if (entry.seo?.noIndex === true) return "noindex";
	return "ok";
}

/** "posts, pages" → ["posts", "pages"]; empty means every collection. */
export function parseCollections(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter((slug) => FIELD.test(slug)))];
}

export function tracks(collections: string[], collection: string): boolean {
	return collections.length === 0 || collections.includes(collection);
}

/**
 * Batch preparation: drop invalid URLs, fragments and URLs of another host (IndexNow rejects the whole
 * request with 422 for a foreign URL), keep first-seen order, remove duplicates.
 */
export function prepareBatch(urls: string[], host: string): { urls: string[]; dropped: string[] } {
	const seen = new Set<string>();
	const dropped: string[] = [];
	for (const raw of urls) {
		let parsed: URL;
		try {
			parsed = new URL(raw.trim());
		} catch {
			dropped.push(raw);
			continue;
		}
		if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.host !== host) {
			dropped.push(raw);
			continue;
		}
		parsed.hash = "";
		seen.add(parsed.href);
	}
	return { urls: [...seen], dropped };
}
