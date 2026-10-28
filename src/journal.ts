import type { PluginContext } from "emdash/plugin";

/**
 * Submission journal (declared storage `submissions`, newest 100 kept), daily counters for the
 * 7-day totals and the last setup problem shown on the dashboard widget (KV).
 */

export interface Submission {
	/** ISO time of the request. */
	at: string;
	/** What triggered it: publish, update, unpublish, delete, restore, resubmit, retry. */
	event: string;
	/** Up to the first 20 submitted URLs; `count` is the full number. */
	urls: string[];
	count: number;
	/** HTTP status, 0 = no response. */
	status: number;
	ok: boolean;
	message: string;
	endpoint: string;
}

export interface SetupProblem {
	at: string;
	status: number;
	message: string;
}

export const JOURNAL_LIMIT = 100;
const KEPT_URLS = 20;
const DAY_MS = 86_400_000;

interface Collection<T> {
	put(id: string, data: T): Promise<void>;
	count(where?: Record<string, unknown>): Promise<number>;
	query(options: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string }): Promise<{
		items: Array<{ id: string; data: T }>;
		cursor?: string;
		hasMore: boolean;
	}>;
	deleteMany(ids: string[]): Promise<number>;
}

const journal = (ctx: PluginContext) => ctx.storage.submissions as unknown as Collection<Submission>;
const dayKey = (iso: string) => `stats:${iso.slice(0, 10)}`;

export async function record(ctx: PluginContext, entry: Omit<Submission, "urls" | "count"> & { urls: string[] }): Promise<void> {
	const id = `${entry.at}-${crypto.randomUUID().slice(0, 8)}`;
	await journal(ctx).put(id, { ...entry, urls: entry.urls.slice(0, KEPT_URLS), count: entry.urls.length });

	const day = dayKey(entry.at);
	const totals = (await ctx.kv.get<{ ok: number; failed: number }>(day)) ?? { ok: 0, failed: 0 };
	await ctx.kv.set(day, entry.ok ? { ...totals, ok: totals.ok + 1 } : { ...totals, failed: totals.failed + 1 });

	await trim(ctx);
}

/** Keep the newest JOURNAL_LIMIT entries and the last 8 days of counters. */
async function trim(ctx: PluginContext): Promise<void> {
	const store = journal(ctx);
	const excess = (await store.count()) - JOURNAL_LIMIT;
	if (excess > 0) {
		const oldest = await store.query({ orderBy: { at: "asc" }, limit: Math.min(excess, 100) });
		await store.deleteMany(oldest.items.map((item) => item.id));
	}
	const cutoff = dayKey(new Date(Date.now() - 8 * DAY_MS).toISOString());
	const stale = (await ctx.kv.list("stats:")).filter((item) => item.key < cutoff);
	await Promise.all(stale.map((item) => ctx.kv.delete(item.key)));
}

export async function recent(ctx: PluginContext, limit = JOURNAL_LIMIT): Promise<Submission[]> {
	const result = await journal(ctx).query({ orderBy: { at: "desc" }, limit: Math.min(limit, 100) });
	return result.items.map((item) => item.data);
}

/** Successful and failed requests over the last 7 days, today included. */
export async function weekTotals(ctx: PluginContext, now = new Date()): Promise<{ ok: number; failed: number }> {
	const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(now.getTime() - i * DAY_MS).toISOString()));
	const values = await Promise.all(days.map((day) => ctx.kv.get<{ ok: number; failed: number }>(day)));
	return values.reduce<{ ok: number; failed: number }>((sum, v) => ({ ok: sum.ok + (v?.ok ?? 0), failed: sum.failed + (v?.failed ?? 0) }), { ok: 0, failed: 0 });
}

export const setupProblem = {
	get: (ctx: PluginContext) => ctx.kv.get<SetupProblem>("state:setupProblem"),
	set: (ctx: PluginContext, problem: SetupProblem) => ctx.kv.set("state:setupProblem", problem),
	clear: (ctx: PluginContext) => ctx.kv.delete("state:setupProblem"),
};
