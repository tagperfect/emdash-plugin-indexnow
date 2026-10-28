import type { Block, BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { ENDPOINTS, generateKey } from "./indexnow";
import { recent, setupProblem, weekTotals, type Submission } from "./journal";
import { keyFileUrl, loadSettings, notReadyReason, siteOrigin, validateSettings, type Settings } from "./settings";
import { resubmitAll } from "./submit";

/** Block Kit admin: Settings page, Submissions page and the dashboard widget, all served by the `admin` route. */

export const SETTINGS_PAGE = "/settings";
export const LOG_PAGE = "/submissions";
export const WIDGET = "status";

const toSettings = { kind: "plugin-page", path: SETTINGS_PAGE } as const;

const RULES_HELP =
	"One rule per line: `<collection> <locale|*> <pattern|-> [conditions]`. Placeholders {slug}, {id}, {locale}; " +
	"`-` = no page. Conditions on entry fields: field=value, field!=value, field (set), !field (empty). " +
	"First match wins; entries without a match use the collection's URL pattern.";

function statusLabel(entry: Submission): string {
	return entry.status === 0 ? "no response" : String(entry.status);
}

function urlCell(entry: Submission): string {
	const first = entry.urls[0] ?? "";
	return entry.count > 1 ? `${first} (+${entry.count - 1})` : first;
}

async function settingsPage(ctx: PluginContext, current?: Settings): Promise<BlockResponse> {
	const settings = current ?? (await loadSettings(ctx));
	const origin = siteOrigin(settings, ctx);
	const reason = notReadyReason(settings, origin);
	const blocks: Block[] = [{ type: "header", text: "IndexNow" }];
	if (reason) blocks.push({ type: "banner", variant: "alert", title: "Not submitting", description: reason });
	if (!settings.key) {
		blocks.push({
			type: "section",
			text: "No key yet. Generate one, then serve it at the key file URL shown below.",
			accessory: { type: "button", action_id: "generate_key", label: "Generate key", style: "primary" },
		});
	}
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{ type: "toggle", action_id: "enabled", label: "Submit URLs to IndexNow", initial_value: settings.enabled },
			{ type: "text_input", action_id: "key", label: "Key", placeholder: "8–128 characters: a–z, A–Z, 0–9, -", initial_value: settings.key },
			{
				type: "select",
				action_id: "endpoint",
				label: "Endpoint",
				options: ENDPOINTS.map((e) => ({ label: e.label, value: e.host })),
				initial_value: settings.endpoint,
			},
			{ type: "text_input", action_id: "collections", label: "Collections", placeholder: "posts, pages (empty = all)", initial_value: settings.collectionsText },
			{ type: "text_input", action_id: "siteUrl", label: "Site URL", placeholder: ctx.site.url || "https://example.com", initial_value: settings.siteUrl },
			{
				type: "select",
				action_id: "keyLocation",
				label: "Key file",
				options: [
					{ label: "Site root: /{key}.txt (recommended)", value: "root" },
					{ label: "Custom URL", value: "custom" },
				],
				initial_value: settings.keyLocation,
			},
			{
				type: "text_input",
				action_id: "keyLocationUrl",
				label: "Key file URL",
				placeholder: "https://example.com/indexnow-key.txt",
				initial_value: settings.keyLocationUrl,
				condition: { field: "keyLocation", eq: "custom" },
			},
			{ type: "text_input", action_id: "urlRules", label: "URL rules (advanced)", multiline: true, initial_value: settings.urlRules },
		],
		submit: { label: "Save", action_id: "save_settings" },
	});
	blocks.push({ type: "context", text: RULES_HELP });
	if (settings.key && origin) {
		blocks.push({
			type: "fields",
			fields: [
				{ label: "Key file must return the key at", value: keyFileUrl(settings, origin) },
				{ label: "Plugin key route", value: `${origin}/_emdash/api/plugins/indexnow/key` },
			],
		});
		blocks.push({
			type: "context",
			text: "A key file covers only URLs in its own folder and below, so serve it at the site root (a static file, a site route, or a URL rewrite to the plugin key route).",
		});
	}
	blocks.push({ type: "actions", elements: [{ type: "link", label: "Submissions", target: { kind: "plugin-page", path: LOG_PAGE } }] });
	return { blocks };
}

async function logPage(ctx: PluginContext): Promise<BlockResponse> {
	const [entries, totals] = await Promise.all([recent(ctx), weekTotals(ctx)]);
	return {
		blocks: [
			{ type: "header", text: "IndexNow submissions" },
			{
				type: "stats",
				items: [
					{ label: "Successful, 7 days", value: totals.ok },
					{ label: "Failed, 7 days", value: totals.failed },
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "resubmit_all",
						label: "Resubmit all published URLs",
						style: "primary",
						confirm: {
							title: "Resubmit all published URLs?",
							text: "Every live, indexable URL of the tracked collections is sent again. Use it after setup or a site move, not routinely.",
							confirm: "Resubmit",
							deny: "Cancel",
						},
					},
					{ type: "link", label: "Settings", target: toSettings },
				],
			},
			{
				type: "table",
				page_action_id: "log_page",
				columns: [
					{ key: "at", label: "Time", format: "relative_time" },
					{ key: "url", label: "URL" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "event", label: "Event" },
					{ key: "message", label: "Message" },
				],
				rows: entries.map((e) => ({ at: e.at, url: urlCell(e), status: statusLabel(e), event: e.event, message: e.message })),
				empty_text: "Nothing submitted yet.",
			},
		],
	};
}

async function widget(ctx: PluginContext): Promise<BlockResponse> {
	const settings = await loadSettings(ctx);
	if (notReadyReason(settings, siteOrigin(settings, ctx))) {
		return {
			blocks: [
				{
					type: "section",
					text: settings.enabled ? "Not configured" : "Off",
					accessory: { type: "link", label: "Set up", target: toSettings, appearance: "primary" },
				},
			],
		};
	}
	const [entries, totals, problem] = await Promise.all([recent(ctx, 5), weekTotals(ctx), setupProblem.get(ctx)]);
	const blocks: Block[] = [];
	if (problem) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: problem.status === 403 ? "Key rejected (403)" : `Setup problem (${problem.status})`,
			description: problem.message,
		});
		blocks.push({ type: "actions", elements: [{ type: "link", label: "Check settings", target: toSettings, appearance: "primary" }] });
	}
	blocks.push({
		type: "stats",
		items: [
			{ label: "OK, 7 days", value: totals.ok },
			{ label: "Failed, 7 days", value: totals.failed, ...(totals.failed ? { trend: "down" as const } : {}) },
		],
	});
	blocks.push({
		type: "table",
		page_action_id: "widget_page",
		columns: [
			{ key: "url", label: "URL" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "at", label: "Time", format: "relative_time" },
		],
		rows: entries.map((e) => ({ url: urlCell(e), status: statusLabel(e), at: e.at })),
		empty_text: "Nothing submitted yet.",
	});
	return { blocks };
}

async function pageFor(ctx: PluginContext, page: string | undefined): Promise<BlockResponse> {
	if (page === `widget:${WIDGET}`) return widget(ctx);
	if (page === LOG_PAGE) return logPage(ctx);
	return settingsPage(ctx);
}

function isInteraction(input: unknown): input is BlockInteraction {
	if (!input || typeof input !== "object") return false;
	const type = (input as { type?: unknown }).type;
	return type === "page_load" || type === "block_action" || type === "form_submit";
}

export async function handleAdmin(input: unknown, ctx: PluginContext): Promise<BlockResponse> {
	if (!isInteraction(input)) return { blocks: [] };
	if (input.type === "page_load") return pageFor(ctx, input.page);

	if (input.type === "form_submit" && input.action_id === "save_settings") {
		const result = validateSettings(input.values);
		if (!result.ok) return { ...(await settingsPage(ctx)), toast: { type: "error", message: result.error } };
		await Promise.all(Object.entries(result.values).map(([name, value]) => ctx.settings.set(name, value)));
		await setupProblem.clear(ctx);
		return { ...(await settingsPage(ctx)), toast: { type: "success", message: "Settings saved" } };
	}

	if (input.type === "block_action" && input.action_id === "generate_key") {
		const settings = await loadSettings(ctx);
		if (!settings.key) await ctx.settings.set("key", generateKey());
		return { ...(await settingsPage(ctx)), toast: { type: "success", message: "Key generated. Serve the key file, then enable submissions." } };
	}

	if (input.type === "block_action" && input.action_id === "resubmit_all") {
		const result = await resubmitAll(ctx);
		const toast = result.error
			? { type: "error" as const, message: result.error }
			: result.outcome?.ok
				? { type: "success" as const, message: `${result.urls} URLs submitted (${result.outcome.status}).` }
				: { type: "error" as const, message: result.outcome?.message ?? "Nothing was sent." };
		return { ...(await logPage(ctx)), toast };
	}

	return pageFor(ctx, input.page);
}
