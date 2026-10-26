<script module lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

	// Links open outside the app instead of replacing it.
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});
</script>

<script lang="ts">
	let { text }: { text: string } = $props();
	const html = $derived(DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true })));
</script>

<div class="markdown">{@html html}</div>
