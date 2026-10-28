import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const SITE = "https://example.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const KEY = "0123456789abcdef0123456789abcdef";

let host: PluginRuntimeTestHost;

/** EmDash runs after-hooks as deferred tasks (`after()`); wait for all of them, including ones they start. */
async function settle() {
	const tasks = (globalThis as Record<symbol, Set<Promise<unknown>> | undefined>)[Symbol.for("emdash:deferred-tasks")];
	for (let i = 0; i < 20 && tasks?.size; i++) await Promise.allSettled([...tasks]);
}

const sent = () =>
	host.http.requests().map((r) => ({ url: r.url, method: r.method, body: JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown> }));

async function respond(status: number, body = "") {
	await host.http.respond(ENDPOINT, new Response(body, { status }));
}

async function createPost(slug: string, seo?: { noIndex: boolean }) {
	const created = await host.actions.content.create("posts", { data: { title: slug }, slug, ...(seo ? { seo } : {}) });
	if (!created.success) throw new Error(JSON.stringify(created.error));
	await settle();
	return created.data.item.id;
}

async function publish(id: string) {
	const result = await host.actions.content.publish("posts", id);
	if (!result.success) throw new Error(JSON.stringify(result.error));
	await settle();
}

beforeEach(async () => {
	host = await createPluginRuntimeTestHost({ site: { url: SITE, locale: "en" } });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/blog/{slug}",
		routable: true,
		hasSeo: true,
		supports: ["drafts", "revisions", "seo"],
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	await host.fixtures.plugin.setting("enabled", true);
	await host.fixtures.plugin.setting("key", KEY);
});

afterEach(async () => {
	await host.dispose();
});

describe("content events", () => {
	it("submits the public URL on publish and journals the 200", async () => {
		const id = await createPost("hello");
		await respond(200);
		await publish(id);

		expect(sent()).toEqual([
			{
				url: ENDPOINT,
				method: "POST",
				body: { host: "example.com", key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList: [`${SITE}/blog/hello`] },
			},
		]);
		const journal = await host.inspect.storage.list<{ status: number; ok: boolean; event: string; urls: string[] }>("submissions");
		expect(journal.map((e) => e.data)).toEqual([expect.objectContaining({ status: 200, ok: true, event: "publish", urls: [`${SITE}/blog/hello`] })]);
	});

	it("does not submit drafts or a draft edit of a live entry", async () => {
		const id = await createPost("draft-only");
		expect(sent()).toEqual([]);

		await respond(200);
		await publish(id);
		host.http.clear();
		const updated = await host.actions.content.update("posts", id, { data: { title: "changed, not yet published" } });
		expect(updated.success).toBe(true);
		await settle();
		expect(sent()).toEqual([]);
	});

	it("submits a changed live entry when the change is published, as an update", async () => {
		const id = await createPost("changed");
		await respond(200);
		await publish(id);
		const updated = await host.actions.content.update("posts", id, { data: { title: "v2" } });
		expect(updated.success).toBe(true);
		await settle();
		await host.fixtures.plugin.kv("state:recent", {}); // past the repeat window
		await respond(200);
		await publish(id);

		expect(sent().map((r) => r.body.urlList)).toEqual([[`${SITE}/blog/changed`], [`${SITE}/blog/changed`]]);
		const events = (await host.inspect.storage.list<{ event: string }>("submissions")).map((e) => e.data.event).sort();
		expect(events).toEqual(["publish", "update"]);
	});

	it("sends a URL once when an entry is published again within a minute", async () => {
		const id = await createPost("twice");
		await respond(200);
		await publish(id);
		const updated = await host.actions.content.update("posts", id, { data: { title: "v2" } });
		expect(updated.success).toBe(true);
		await settle();
		await publish(id);
		expect(sent()).toHaveLength(1);
	});

	it("does not submit noindex entries", async () => {
		const id = await createPost("hidden", { noIndex: true });
		await publish(id);
		expect(sent()).toEqual([]);
	});

	it("submits the last known URL on unpublish and on trash", async () => {
		const a = await createPost("gone");
		const b = await createPost("trashed");
		await respond(200);
		await publish(a);
		await respond(202);
		await publish(b);
		host.http.clear();

		await respond(200);
		const unpublished = await host.actions.content.unpublish("posts", a);
		expect(unpublished.success).toBe(true);
		await settle();
		await respond(200);
		const trashed = await host.actions.content.trash("posts", b);
		expect(trashed.success).toBe(true);
		await settle();

		expect(sent().map((r) => r.body.urlList)).toEqual([[`${SITE}/blog/gone`], [`${SITE}/blog/trashed`]]);
		const events = (await host.inspect.storage.list<{ event: string }>("submissions")).map((e) => e.data.event).sort();
		expect(events).toEqual(["delete", "publish", "publish", "unpublish"]);
	});

	it("does nothing while disabled", async () => {
		await host.fixtures.plugin.setting("enabled", false);
		await publish(await createPost("off"));
		expect(sent()).toEqual([]);
	});

	it("uses URL rules and the Site URL setting", async () => {
		await host.fixtures.plugin.setting("siteUrl", "https://www.example.org");
		await host.fixtures.plugin.setting("urlRules", "posts * /news/{slug}/");
		await respond(200);
		await publish(await createPost("ruled"));
		expect(sent()[0]!.body).toMatchObject({ host: "www.example.org", urlList: ["https://www.example.org/news/ruled/"] });
	});

	it("records a 403 as a setup problem shown on the widget, and queues a 429 for retry", async () => {
		await respond(403, "key mismatch");
		await publish(await createPost("bad-key"));
		expect(await host.inspect.kv.get("state:setupProblem")).toMatchObject({ status: 403 });
		const widget = await host.admin.loadWidget("status");
		expect(JSON.stringify(widget.blocks)).toContain("Key rejected (403)");

		await respond(429);
		await publish(await createPost("rate-limited"));
		expect(await host.inspect.kv.get("state:retry")).toEqual([`${SITE}/blog/rate-limited`]);
	});
});

describe("admin", () => {
	it("shows 'not configured' on the widget without a key", async () => {
		await host.fixtures.plugin.setting("key", "");
		const widget = await host.admin.loadWidget("status");
		expect(JSON.stringify(widget.blocks)).toContain("Not configured");
	});

	it("generates a key once and validates the settings form", async () => {
		await host.fixtures.plugin.setting("key", "");
		await host.fixtures.plugin.setting("enabled", false);
		await host.admin.act("/settings", "generate_key");
		const key = await host.inspect.setting<string>("key");
		expect(key).toMatch(/^[0-9a-f]{32}$/);

		const rejected = await host.admin.submit("/settings", "save_settings", { enabled: true, key: "bad" });
		expect(rejected.toast?.type).toBe("error");
		const saved = await host.admin.submit("/settings", "save_settings", { enabled: true, key: key!, collections: "posts", endpoint: "www.bing.com" });
		expect(saved.toast?.type).toBe("success");
		expect(await host.inspect.setting("endpoint")).toBe("www.bing.com");
	});

	it("resubmits all published URLs in one batch", async () => {
		await host.fixtures.plugin.setting("collections", "posts");
		for (const slug of ["one", "two"]) {
			await respond(200);
			await publish(await createPost(slug));
		}
		await createPost("draft");
		host.http.clear();

		await respond(200);
		const page = await host.admin.act("/submissions", "resubmit_all");
		expect(page.toast).toMatchObject({ type: "success" });
		expect(sent()).toHaveLength(1);
		expect((sent()[0]!.body.urlList as string[]).sort()).toEqual([`${SITE}/blog/one`, `${SITE}/blog/two`]);
		expect(JSON.stringify(page.blocks)).toContain("resubmit");
	});

	it("serves the key on the public key route", async () => {
		const response = await host.actions.routes.request("key", { method: "GET" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(KEY);
	});
});
