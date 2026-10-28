import { describe, expect, it } from "vitest";

import { chunk, interpret, KEY_PATTERN, generateKey, requestBody } from "../src/indexnow";
import { validateSettings } from "../src/settings";
import { fillPattern, findRule, indexability, parseCollections, parseRules, prepareBatch, rebase, type EntryRef } from "../src/urls";

const entry = (over: Partial<EntryRef> = {}): EntryRef => ({
	collection: "services",
	id: "01ABC",
	slug: "implants",
	locale: "et",
	status: "published",
	data: {},
	...over,
});

describe("URL rules", () => {
	const { rules, errors } = parseRules(`
# services: own page unless it is a section of another page
services * - card_link
services et /teenused/{slug}/
services ru /ru/uslugi/{slug}/
doctors  *  - staff_type!=doctor
doctors  et /personal/{slug}/
pages    et / page_key=home
pages    ru /ru/ page_key=home
pages    *  /{locale}/{slug}/
price_items et /hinnad/
`);

	it("parses every line without errors", () => {
		expect(errors).toEqual([]);
		expect(rules).toHaveLength(9);
	});

	it("builds localized paths per collection and locale", () => {
		expect(fillPattern(findRule(rules, entry())!.pattern!, entry())).toBe("/teenused/implants/");
		const ru = entry({ locale: "ru", slug: "implanty" });
		expect(fillPattern(findRule(rules, ru)!.pattern!, ru)).toBe("/ru/uslugi/implanty/");
	});

	it("honours conditions: `-` rules mean no page", () => {
		expect(findRule(rules, entry({ data: { card_link: "other#x" } }))!.pattern).toBeNull();
		const nurse = entry({ collection: "doctors", data: { staff_type: "assistant" } });
		expect(findRule(rules, nurse)!.pattern).toBeNull();
		const doctor = entry({ collection: "doctors", slug: "anna", data: { staff_type: "doctor" } });
		expect(fillPattern(findRule(rules, doctor)!.pattern!, doctor)).toBe("/personal/anna/");
	});

	it("matches field equality and falls through to the generic rule", () => {
		const home = entry({ collection: "pages", locale: "ru", slug: "glavnaya", data: { page_key: "home" } });
		expect(findRule(rules, home)!.pattern).toBe("/ru/");
		const about = entry({ collection: "pages", locale: "en", slug: "about", data: { page_key: "about" } });
		expect(fillPattern(findRule(rules, about)!.pattern!, about)).toBe("/en/about/");
	});

	it("returns no rule for an unknown collection or locale", () => {
		expect(findRule(rules, entry({ collection: "posts" }))).toBeUndefined();
		expect(findRule(rules, entry({ collection: "price_items", locale: "fi" }))).toBeUndefined();
	});

	it("gives no path when a placeholder is empty, and encodes slugs", () => {
		expect(fillPattern("/blog/{slug}/", entry({ slug: null }))).toBeNull();
		expect(fillPattern("/blog/{slug}/", entry({ slug: "ä b" }))).toBe("/blog/%C3%A4%20b/");
	});

	it("reports malformed lines", () => {
		const bad = parseRules("posts\nposts * blog/{slug}\nposts * /b/ a==b c<d");
		expect(bad.rules).toEqual([]);
		expect(bad.errors).toHaveLength(3);
	});
});

describe("draft and noindex filtering", () => {
	it("submits only published entries that are not noindex", () => {
		expect(indexability(entry())).toBe("ok");
		expect(indexability(entry({ status: "draft" }))).toBe("draft");
		expect(indexability(entry({ status: "scheduled" }))).toBe("draft");
		expect(indexability(entry({ seo: { noIndex: true } }))).toBe("noindex");
		expect(indexability(entry({ seo: { noIndex: false } }))).toBe("ok");
	});
});

describe("batch preparation", () => {
	it("de-duplicates, strips fragments and keeps order", () => {
		const { urls, dropped } = prepareBatch(
			["https://example.com/a/", "https://example.com/b/#top", "https://example.com/a/", "https://example.com/b/"],
			"example.com",
		);
		expect(urls).toEqual(["https://example.com/a/", "https://example.com/b/"]);
		expect(dropped).toEqual([]);
	});

	it("drops invalid URLs and URLs of another host", () => {
		const { urls, dropped } = prepareBatch(["https://example.com/a/", "https://staging.example.com/a/", "not a url", "ftp://example.com/x"], "example.com");
		expect(urls).toEqual(["https://example.com/a/"]);
		expect(dropped).toHaveLength(3);
	});

	it("splits into requests of at most 10,000 URLs", () => {
		const sizes = chunk(Array.from({ length: 25_001 }, (_, i) => i)).map((c) => c.length);
		expect(sizes).toEqual([10_000, 10_000, 5_001]);
	});

	it("builds the protocol body", () => {
		expect(requestBody("example.com", "k", "https://example.com/k.txt", ["https://example.com/"])).toEqual({
			host: "example.com",
			key: "k",
			keyLocation: "https://example.com/k.txt",
			urlList: ["https://example.com/"],
		});
	});

	it("rebases host public URLs onto the configured site URL", () => {
		expect(rebase("http://localhost:4321/blog/x/?a=1", "https://example.com")).toBe("https://example.com/blog/x/?a=1");
	});
});

describe("response handling", () => {
	it.each([
		[200, true, false, false, "Submitted."],
		[202, true, false, false, "key validation pending"],
		[400, false, false, false, "invalid"],
		[403, false, false, true, "Key not valid"],
		[422, false, false, true, "do not belong to the host"],
		[429, false, true, false, "Too many requests"],
		[503, false, true, false, "Search engine error 503"],
		[0, false, true, false, "Network error"],
		[418, false, false, false, "Unexpected response 418"],
	])("%i", (status, ok, retry, setupProblem, text) => {
		const outcome = interpret(status);
		expect(outcome).toMatchObject({ status, ok, retry, setupProblem });
		expect(outcome.message).toContain(text);
	});

	it("appends the response body of a failure, trimmed", () => {
		expect(interpret(403, "  Key   mismatch\n").message).toMatch(/Key mismatch$/);
		expect(interpret(200, "ignored").message).toBe("Submitted.");
	});
});

describe("settings", () => {
	it("generates valid keys", () => {
		expect(generateKey()).toMatch(KEY_PATTERN);
		expect(generateKey()).not.toBe(generateKey());
	});

	it("validates the form", () => {
		expect(validateSettings({ enabled: true, key: "" })).toMatchObject({ ok: false });
		expect(validateSettings({ key: "short" })).toMatchObject({ ok: false });
		expect(validateSettings({ key: "abcd1234", siteUrl: "example.com" })).toMatchObject({ ok: false });
		expect(validateSettings({ key: "abcd1234", endpoint: "evil.example" })).toMatchObject({ ok: false });
		expect(validateSettings({ key: "abcd1234", urlRules: "posts * nope" })).toMatchObject({ ok: false });
		expect(validateSettings({ enabled: true, key: "abcd1234", siteUrl: "https://example.com/", collections: "posts,pages  posts" })).toEqual({
			ok: true,
			values: expect.objectContaining({ enabled: true, siteUrl: "https://example.com", collections: "posts, pages", endpoint: "api.indexnow.org" }),
		});
	});

	it("parses the collection list", () => {
		expect(parseCollections(" posts, pages\nprice_items ")).toEqual(["posts", "pages", "price_items"]);
		expect(parseCollections("")).toEqual([]);
	});
});
