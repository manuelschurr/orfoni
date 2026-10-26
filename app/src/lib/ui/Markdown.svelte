<script module lang="ts">
	import { isTauri } from '@tauri-apps/api/core';
	import { openUrl } from '@tauri-apps/plugin-opener';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

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
	const html = $derived(DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true })));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown" onclick={openOutside} onauxclick={openOutside}>{@html html}</div>
