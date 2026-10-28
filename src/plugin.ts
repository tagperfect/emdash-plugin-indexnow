import { pluginResponse, type SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin";
import { loadSettings } from "./settings";
import { afterDelete, beforeDelete, flushRetries, onLive, onUnpublished } from "./submit";

/**
 * IndexNow for EmDash: on publish, update of a live entry, unpublish and delete, the entry's public URL
 * is POSTed to an IndexNow endpoint. Drafts and noindex entries are never sent. Hooks run after the
 * content action and never fail it: errors are logged and journaled.
 */

const RETRY_TASK = "retry";
const idOf = (content: Record<string, unknown>) => (typeof content.id === "string" ? content.id : "");

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ctx.cron?.schedule(RETRY_TASK, { schedule: "*/30 * * * *" });
		},
		"plugin:deactivate": async (_event, ctx) => {
			await ctx.cron?.cancel(RETRY_TASK);
		},
		"content:afterPublish": {
			errorPolicy: "continue",
			handler: async (event, ctx) => onLive(ctx, event.collection, idOf(event.content), "publish"),
		},
		"content:afterSave": {
			errorPolicy: "continue",
			handler: async (event, ctx) => onLive(ctx, event.collection, idOf(event.content), "update"),
		},
		"content:afterRestore": {
			errorPolicy: "continue",
			handler: async (event, ctx) => onLive(ctx, event.collection, idOf(event.content), "restore"),
		},
		"content:afterUnpublish": {
			errorPolicy: "continue",
			handler: async (event, ctx) => onUnpublished(ctx, event.collection, idOf(event.content)),
		},
		"content:beforeDelete": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				await beforeDelete(ctx, event.collection, event.id);
			},
		},
		"content:afterDelete": {
			errorPolicy: "continue",
			handler: async (event, ctx) => afterDelete(ctx, event.collection, event.id),
		},
		cron: async (event, ctx) => {
			if (event.name === RETRY_TASK) await flushRetries(ctx);
		},
	},
	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, ctx),
		},
		/** The key as text/plain, for sites that rewrite `/{key}.txt` to this route. 404 while unset. */
		key: {
			public: true,
			methods: ["GET", "HEAD"],
			response: "raw",
			cacheControl: "public, max-age=300",
			handler: async (_routeCtx, ctx) => {
				const { key } = await loadSettings(ctx);
				return key
					? pluginResponse({ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: { kind: "text", value: key } })
					: pluginResponse({ status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "Not found" } });
			},
		},
	},
};

export default plugin;
