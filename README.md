# IndexNow for EmDash

Notifies search engines through [IndexNow](https://www.indexnow.org) when content on an [EmDash](https://emdashcms.com) site is published, changed, unpublished or deleted, so they recrawl the page right away instead of waiting for the next crawl.

- Sends the entry's public URL on **publish**, on **publishing a change** to a live entry, on **unpublish** and on **delete** (IndexNow accepts removed URLs: the engine recrawls them and drops them).
- Never sends drafts or entries marked **noindex** in the SEO panel.
- Builds absolute URLs from the collection's URL pattern and locale prefix, or from your own **URL rules** for localized sections.
- Batches with `POST` + `urlList` (up to 10,000 URLs per request), removes duplicates and foreign-host URLs.
- Logs every request with a readable explanation of the response (200, 202, 400, 403, 422, 429, 5xx) and retries 429, 5xx and network errors every 30 minutes.
- Admin: a Settings page, a Submissions journal (newest 100) with **Resubmit all published URLs**, and a dashboard widget.
- Standard plugin format: runs trusted (`plugins: []`) or sandboxed (`sandboxed: []`), and installs from the EmDash plugin registry.

## Engines

IndexNow is shared: a URL sent to one participating engine reaches all of them. That covers Bing (and the products built on its index), Yandex, Seznam, Naver, Yep and other participants.

**Google does not support IndexNow.** Keep your sitemap for Google.

## Install

Requires EmDash 1.3.1 or later.

### From npm

```sh
pnpm add @tagperfect/emdash-plugin-indexnow
```

```ts title="astro.config.mjs"
import indexnow from "@tagperfect/emdash-plugin-indexnow";

emdash({
	// Trusted, in the site's process:
	plugins: [indexnow],
	// …or isolated, when the Worker Loader binding is available (Cloudflare):
	// sandboxed: [indexnow],
	// sandboxRunner: sandbox(), // from "@emdash-cms/cloudflare"
});
```

### From the EmDash registry

In the admin, open **Plugins → Marketplace**, find **IndexNow** and install it. The install dialog lists the capabilities and the public route below for approval.

## Setup

1. Open **IndexNow** in the admin sidebar.
2. Click **Generate key** (or paste an existing key: 8–128 characters, letters, digits and dashes).
3. Serve the key file. The page shows the exact URL, by default `https://your-site/{key}.txt`; it must return the key as plain text. Any of these works:
   - a static file `public/{key}.txt` in your site;
   - a site route that returns the key;
   - a URL rewrite (for example a Cloudflare Transform Rule) from `/{key}.txt` to the plugin's key route `/_emdash/api/plugins/indexnow/key`.
4. Turn on **Submit URLs to IndexNow** and save.

The key file must sit at the site root: per the protocol, a key file covers only URLs in its own folder and below, so a key served only under `/_emdash/api/plugins/…` would not cover your pages. Use **Key file → Custom URL** only if the file lives elsewhere at the root of the same host.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Submit URLs to IndexNow | off | Master switch. Nothing is sent while it is off. |
| Key | empty | The IndexNow key. **Generate key** creates a 32-character key. |
| Endpoint | `api.indexnow.org` | Where requests go. Any participant shares the URLs with the others; Bing, Yandex, Seznam, Naver and Yep endpoints can be chosen directly. |
| Collections | none checked (all) | The collections to track, picked from the site's collections. With none checked, every collection is tracked and **Resubmit all** reads every visible collection. |
| Site URL | EmDash's site URL | The origin of submitted URLs, e.g. `https://example.com`. Set it when the admin runs on another host. Only URLs on this host are sent. |
| Key file | Site root | `https://site/{key}.txt`, or a custom URL on the same host. |
| URL rules | empty | Optional rules for URLs that the collection URL pattern cannot express (see below). |

### URL rules

Without rules, the plugin uses EmDash's public URL of the entry: the collection URL pattern with the locale prefix. When sections are localized (`/services/…` in one language, `/ru/uslugi/…` in another), or an entry's change should ping another page, add rules, one per line:

```text
# <collection> <locale|*> <pattern|-> [conditions…]
services *  -                card_link            # a section of another page: no URL of its own
services et /teenused/{slug}/
services ru /ru/uslugi/{slug}/
doctors  *  -                staff_type!=doctor
pages    et /                page_key=home
pages    *  /{locale}/{slug}/
price_items et /hinnad/                           # a price change pings the price list
```

- Placeholders: `{slug}`, `{id}`, `{locale}`. Slugs are URL-encoded.
- `-` means the entry has no page: nothing is sent.
- Conditions test entry fields (and `slug`, `locale`, `id`): `field=value`, `field!=value`, `field` (non-empty), `!field` (empty).
- The first matching rule wins. Entries without a matching rule fall back to the collection URL pattern.

## Admin

- **IndexNow** (settings): the form above, the key file URL and the plugin key route.
- **IndexNow submissions**: totals for the last 7 days, the newest 100 requests (time, URL, status, event, message) and **Resubmit all published URLs**: every live, indexable URL of the tracked collections in one batch, for the first setup or a domain move.
- **Dashboard widget**: the last 5 requests and the 7-day totals; a warning with a link to the settings when the key is rejected (403) or URLs do not match the host (422); "Off" or "Not configured" with a **Set up** link otherwise.

## Capabilities

| Capability | Why |
| --- | --- |
| `content:read` | Read the changed entry: its status (drafts are skipped), SEO `noIndex` flag, slug, locale and fields used by URL rules, and its public URL. **Resubmit all** lists published entries of the tracked collections. |
| `schema:read` | List the site's collections for the **Collections** checkboxes, and for **Resubmit all** when none are selected. |
| `network:request` with `allowedHosts`: `api.indexnow.org`, `www.bing.com`, `yandex.com`, `search.seznam.cz`, `searchadvisor.naver.com`, `indexnow.yep.com` | `POST` the URL list to the IndexNow endpoint chosen in Settings. No other host can be reached. |

No other host APIs are used. Settings, the journal (declared storage `submissions`) and internal state (KV) are plugin-scoped and need no capability.

**Public route:** `GET /_emdash/api/plugins/indexnow/key` returns the key as `text/plain` (404 while no key is set). The key is public by design: search engines read it to verify the host.

## Limits

- Google does not use IndexNow.
- EmDash saves edits to a live entry as a draft; the URL is sent when that change is published, not on every save.
- After unpublish or delete, the plugin sends the URL it last submitted for that entry. For entries published before the plugin was installed, it uses a URL rule if one matches; run **Resubmit all** once after setup so every live entry has a known URL.
- Publishing the same entry again within 60 seconds does not resend its URL.
- **Resubmit all** reads up to 5,000 entries per run.
- Only URLs on the Site URL host are sent; IndexNow rejects a request that mixes hosts.
- **Cloudflare Workers:** `api.indexnow.org` and `www.bing.com` may answer `429 Too many requests` to every request from a Worker (Bing rate-limits Cloudflare's shared egress addresses). Choose `yandex.com` or `searchadvisor.naver.com` as the endpoint: the URLs still reach Bing and the other participants.

## Develop

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm test        # builds the plugin and runs it through EmDash's sandbox host
pnpm run build
pnpm run bundle  # registry tarball in dist/
```

## License

MIT, see [LICENSE](./LICENSE).

---

Made by [Tag Perfect](https://tagperfect.eu).
