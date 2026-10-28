import type { PluginContext } from "emdash/plugin";

import { chunk, endpointUrl, interpret, requestBody, type Outcome } from "./indexnow";
import { record, setupProblem } from "./journal";
import { keyFileUrl, loadSettings, notReadyReason, siteOrigin, type Settings } from "./settings";
import { fillPattern, findRule, indexability, joinUrl, parseRules, prepareBatch, rebase, tracks, type EntryRef } from "./urls";

/** KV keys: last submitted URL of an entry (needed after unpublish/delete, when the host no longer resolves it). */
const urlKey = (collection: string, id: string) => `url:${collection}:${id}`;
const goneKey = (collection: string, id: string) => `gone:${collection}:${id}`;
const RETRY_KEY = "state:retry";
const RETRY_LIMIT = 10_000;

export function toEntry(collection: string, item: Record<string, unknown>): EntryRef {
	const s = (v: unknown) => (typeof v === "string" ? v : null);
	return {
		collection,
		id: String(item.id ?? ""),
		slug: s(item.slug),
		locale: s(item.locale),
		status: s(item.status) ?? "",
		data: (item.data && typeof item.data === "object" ? item.data : {}) as Record<string, unknown>,
		seo: (item.seo ?? null) as EntryRef["seo"],
	};
}

/**
 * Absolute URL of an entry: the first matching URL rule wins (a `-` rule means "no page"); otherwise
 * EmDash's public URL of a published entry (collection URL pattern + locale prefix).
 */
export async function resolveUrl(ctx: PluginContext, settings: Settings, origin: string, entry: EntryRef): Promise<string | null> {
	const rule = findRule(parseRules(settings.urlRules).rules, entry);
	if (rule) {
		const path = rule.pattern && fillPattern(rule.pattern, entry);
		return path ? joinUrl(origin, path) : null;
	}
	if (entry.status !== "published") return null;
	const url = await ctx.content?.getPublicUrl?.(entry.collection, entry.id);
	return url ? rebase(url, origin) : null;
}

/**
 * POST the URLs to the configured endpoint in batches of up to 10,000, journal every request.
 * Returns the last outcome, or `null` when nothing was sent.
 */
export async function submitUrls(ctx: PluginContext, settings: Settings, urls: string[], event: string): Promise<Outcome | null> {
	const origin = siteOrigin(settings, ctx);
	const reason = notReadyReason(settings, origin);
	if (reason || !origin) {
		ctx.log.info(`IndexNow: not sent (${reason})`, { urls });
		return null;
	}
	const host = new URL(origin).host;
	const batch = prepareBatch(urls, host);
	if (batch.dropped.length) ctx.log.warn(`IndexNow: skipped URLs outside ${host}`, { urls: batch.dropped });
	if (!batch.urls.length) return null;
	if (!ctx.http) throw new Error("IndexNow: the network:request capability is not granted.");

	let last: Outcome | null = null;
	for (const urlList of chunk(batch.urls)) {
		let outcome: Outcome;
		try {
			const response = await ctx.http.fetch(endpointUrl(settings.endpoint), {
				method: "POST",
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify(requestBody(host, settings.key, keyFileUrl(settings, origin), urlList)),
			});
			outcome = interpret(response.status, response.ok ? "" : await response.text().catch(() => ""));
		} catch (error) {
			outcome = interpret(0, error instanceof Error ? error.message : String(error));
		}
		const at = new Date().toISOString();
		await record(ctx, { at, event, urls: urlList, status: outcome.status, ok: outcome.ok, message: outcome.message, endpoint: settings.endpoint });
		const log = { status: outcome.status, count: urlList.length, urls: urlList.slice(0, 5), endpoint: settings.endpoint };
		if (outcome.ok) {
			ctx.log.info(`IndexNow ${outcome.status}: ${outcome.message}`, log);
			await setupProblem.clear(ctx);
		} else {
			ctx.log.warn(`IndexNow ${outcome.status}: ${outcome.message}`, log);
			if (outcome.setupProblem) await setupProblem.set(ctx, { at, status: outcome.status, message: outcome.message });
			if (outcome.retry && event !== "retry") await queueRetry(ctx, urlList);
		}
		last = outcome;
	}
	return last;
}

async function queueRetry(ctx: PluginContext, urls: string[]): Promise<void> {
	const queued = (await ctx.kv.get<string[]>(RETRY_KEY)) ?? [];
	await ctx.kv.set(RETRY_KEY, [...new Set([...queued, ...urls])].slice(-RETRY_LIMIT));
}

/** Cron: send URLs whose request failed with 429 / 5xx / a network error. One attempt per run. */
export async function flushRetries(ctx: PluginContext): Promise<void> {
	const queued = (await ctx.kv.get<string[]>(RETRY_KEY)) ?? [];
	if (!queued.length) return;
	await ctx.kv.delete(RETRY_KEY);
	const outcome = await submitUrls(ctx, await loadSettings(ctx), queued, "retry");
	if (outcome?.retry) await queueRetry(ctx, queued);
}

type Trigger = "publish" | "update" | "restore";

/** Entry became (or stayed) live with new content. */
export async function onLive(ctx: PluginContext, collection: string, id: string, trigger: Trigger): Promise<void> {
	const settings = await loadSettings(ctx);
	if (!settings.enabled || !tracks(settings.collections, collection) || !id) return;
	const item = await ctx.content?.get(collection, id);
	if (!item) return;
	const entry = toEntry(collection, item as unknown as Record<string, unknown>);
	// A save that only created a draft revision leaves the live page unchanged.
	if (trigger === "update" && item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId) return;
	const state = indexability(entry);
	if (state !== "ok") {
		ctx.log.info(`IndexNow: ${collection}/${id} skipped (${state})`);
		if (state === "noindex") await ctx.kv.delete(urlKey(collection, id));
		return;
	}
	const origin = siteOrigin(settings, ctx);
	const url = origin && (await resolveUrl(ctx, settings, origin, entry));
	if (!url) {
		ctx.log.info(`IndexNow: ${collection}/${id} has no public URL`);
		return;
	}
	// Publishing an entry that already had a submitted URL is a change of a live page.
	const known = await ctx.kv.get<string>(urlKey(collection, id));
	await ctx.kv.set(urlKey(collection, id), url);
	if (await recentlySent(ctx, url)) {
		ctx.log.info(`IndexNow: ${url} skipped (sent less than ${REPEAT_WINDOW_MS / 1000} s ago)`);
		return;
	}
	await submitUrls(ctx, settings, [url], trigger === "publish" && known ? "update" : trigger);
}

/** Repeated publishes of one entry within this window (e.g. save + publish from a script) send the URL once. */
export const REPEAT_WINDOW_MS = 60_000;
const RECENT_KEY = "state:recent";

/** True when the URL went out within REPEAT_WINDOW_MS; otherwise records it as sent now. */
async function recentlySent(ctx: PluginContext, url: string, now = Date.now()): Promise<boolean> {
	const recent = (await ctx.kv.get<Record<string, number>>(RECENT_KEY)) ?? {};
	const fresh = Object.fromEntries(Object.entries(recent).filter(([, at]) => now - at < REPEAT_WINDOW_MS));
	if (fresh[url] !== undefined) return true;
	await ctx.kv.set(RECENT_KEY, { ...fresh, [url]: now });
	return false;
}

/** Entry left the site: submit its last known URL so engines recrawl it and drop it. */
export async function onUnpublished(ctx: PluginContext, collection: string, id: string): Promise<void> {
	const settings = await loadSettings(ctx);
	if (!settings.enabled || !tracks(settings.collections, collection) || !id) return;
	let url = await ctx.kv.get<string>(urlKey(collection, id));
	if (!url) {
		// Never submitted (e.g. published before the plugin was installed): a URL rule can still name it.
		const item = await ctx.content?.get(collection, id);
		const origin = siteOrigin(settings, ctx);
		if (item && origin) url = await resolveUrl(ctx, settings, origin, { ...toEntry(collection, item as unknown as Record<string, unknown>), status: "published" });
	}
	if (!url) return;
	await ctx.kv.delete(urlKey(collection, id));
	await submitUrls(ctx, settings, [url], "unpublish");
}

/** Before delete: remember the URL while the entry still resolves. */
export async function beforeDelete(ctx: PluginContext, collection: string, id: string): Promise<void> {
	const settings = await loadSettings(ctx);
	if (!settings.enabled || !tracks(settings.collections, collection)) return;
	let url = await ctx.kv.get<string>(urlKey(collection, id));
	if (!url) {
		const item = await ctx.content?.get(collection, id);
		const origin = siteOrigin(settings, ctx);
		if (item && origin && indexability(toEntry(collection, item as unknown as Record<string, unknown>)) === "ok") {
			url = await resolveUrl(ctx, settings, origin, toEntry(collection, item as unknown as Record<string, unknown>));
		}
	}
	if (url) await ctx.kv.set(goneKey(collection, id), url);
}

export async function afterDelete(ctx: PluginContext, collection: string, id: string): Promise<void> {
	const url = await ctx.kv.get<string>(goneKey(collection, id));
	if (!url) return;
	await Promise.all([ctx.kv.delete(goneKey(collection, id)), ctx.kv.delete(urlKey(collection, id))]);
	await submitUrls(ctx, await loadSettings(ctx), [url], "delete");
}

/** Max entries read per "resubmit all" run, to stay inside one request's limits. */
export const RESUBMIT_LIMIT = 5_000;

/** Collect the URLs of every live, indexable entry in the tracked collections and submit them. */
export async function resubmitAll(ctx: PluginContext): Promise<{ outcome: Outcome | null; urls: number; error?: string }> {
	const settings = await loadSettings(ctx);
	const origin = siteOrigin(settings, ctx);
	const reason = notReadyReason(settings, origin);
	if (reason || !origin) return { outcome: null, urls: 0, error: reason ?? "Site URL unknown." };
	const collections = settings.collections.length ? settings.collections : [...new Set(parseRules(settings.urlRules).rules.map((r) => r.collection))];
	if (!collections.length) return { outcome: null, urls: 0, error: "List the collections to submit in Settings → Collections." };

	const urls: string[] = [];
	let read = 0;
	for (const collection of collections) {
		let cursor: string | undefined;
		do {
			const page = await ctx.content!.list(collection, { where: { status: "published" }, limit: 100, cursor });
			for (const item of page.items) {
				const entry = toEntry(collection, item as unknown as Record<string, unknown>);
				if (indexability(entry) !== "ok") continue;
				const url = await resolveUrl(ctx, settings, origin, entry);
				if (!url) continue;
				urls.push(url);
				await ctx.kv.set(urlKey(collection, entry.id), url);
			}
			read += page.items.length;
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor && read < RESUBMIT_LIMIT);
	}
	const unique = [...new Set(urls)];
	if (!unique.length) return { outcome: null, urls: 0, error: "No published URLs found." };
	return { outcome: await submitUrls(ctx, settings, unique, "resubmit"), urls: unique.length };
}
