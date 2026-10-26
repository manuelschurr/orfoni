<script module lang="ts">
	import { isTauri } from '@tauri-apps/api/core';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import DOMPurify, { type Config } from 'dompurify';
	import { Marked } from 'marked';

	// Claude's replies can carry text it read from anywhere, so only the markup that markdown itself produces survives.
	const ALLOWED: Config = {
		ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
		ALLOWED_ATTR: ['align', 'href', 'start', 'title'],
		ALLOW_ARIA_ATTR: false,
		ALLOW_DATA_ATTR: false,
	};

	// An image would be fetched as soon as it renders, and its address can carry whatever the reply put there.
	const markdown = new Marked({
		gfm: true,
		renderer: {
			image({ href, text }) {
				const label = `Image: ${text || href}`;
				return this.link({ type: 'link', raw: label, href, title: null, text: label, tokens: [{ type: 'text', raw: label, text: label }] });
			},
			checkbox({ checked }) {
				return checked ? '☑ ' : '☐ ';
			},
		},
	});

	// Links open outside the app instead of replacing it.
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});

	function webAddress(href: string | null): string | null {
		if (!href || !URL.canParse(href)) return null;
		const url = new URL(href);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	}

	// The webview would open a link inside the app window, so Tauri hands web links to the system browser and drops the rest.
	function openOutside(event: MouseEvent): void {
		const link = (event.target as Element).closest('a');
		if (!link || !isTauri()) return;
		event.preventDefault();
		const address = webAddress(link.getAttribute('href'));
		if (address) openUrl(address).catch((error: unknown) => console.warn('open_url', error));
	}
</script>

<script lang="ts">
	let { text }: { text: string } = $props();
	const html = $derived(DOMPurify.sanitize(markdown.parse(text, { async: false }), ALLOWED));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown" onclick={openOutside} onauxclick={openOutside}>{@html html}</div>
