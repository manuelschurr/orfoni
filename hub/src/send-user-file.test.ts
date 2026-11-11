import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { sentCall } from './send-user-file.js';

// A real PostToolUse of a call with relative paths, from Claude Code 2.1.322, which resolved them against its working directory.
const post = JSON.parse(readFileSync(new URL('../test/fixtures/hooks/PostToolUse-SendUserFile.json', import.meta.url), 'utf8')) as { tool_input: unknown; tool_response: unknown };

const delivered = (...paths: string[]) => `${paths.length} file${paths.length === 1 ? '' : 's'} delivered to user.\n${paths.map((path, index) => `  ${path} → file_uuid: 0de3a1f1-2fd0-4c80-b209-01cf6cb5484${index}`).join('\n')}`;

describe('sentCall', () => {
	test('a live call names each file by the path and size Claude Code resolved, in the order of its input', () => {
		expect(sentCall(post.tool_input, post.tool_response, '/somewhere/else')).toEqual({
			caption: 'spike',
			render: true,
			files: [
				{ path: '/var/tmp/claude-0/orfoni-spike-send/icon.png', size: 2225 },
				{ path: '/var/tmp/claude-0/orfoni-spike-send/sub/report.md', size: 17 },
			],
		});
	});

	test('a call still running names its files by its input, a relative one against the folder, with no sizes', () => {
		expect(sentCall({ files: ['/w/a.pdf', 'out/../b.png'], status: 'normal' }, undefined, '/w/proj')).toEqual({
			caption: null,
			render: false,
			files: [
				{ path: '/w/a.pdf', size: null },
				{ path: '/w/proj/b.png', size: null },
			],
		});
	});

	test("a call from history takes each path from its result's delivered lines, also after Claude moved to another folder, and paths with spaces", () => {
		const input = { files: ['report.pdf', '/w/My CV.pdf'], display: 'attach' };
		expect(sentCall(input, delivered('/w/proj/sub/report.pdf', '/w/My CV.pdf'), '/w/proj').files).toEqual([
			{ path: '/w/proj/sub/report.pdf', size: null },
			{ path: '/w/My CV.pdf', size: null },
		]);
	});

	test('a file missing from the delivered lines, as one that failed to upload, is still found by its relative path', () => {
		const input = { files: ['/w/gone.png', 'out/a.png'] };
		expect(sentCall(input, delivered('/w/proj/sub/out/a.png'), '/w/proj').files).toEqual([
			{ path: '/w/gone.png', size: null },
			{ path: '/w/proj/sub/out/a.png', size: null },
		]);
	});

	test('an input this hub cannot read as SendUserFile has no files to show', () => {
		expect(sentCall({ file: 'a.png' }, undefined, '/w')).toBeNull();
		expect(sentCall({ files: [] }, undefined, '/w')).toBeNull();
		expect(sentCall(undefined, post.tool_response, '/w')).toBeNull();
	});
});
