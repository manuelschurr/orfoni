import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';

// Claude Code's SendUserFile formats are undocumented. These are as measured on Claude Code 2.1.322.
export const SEND_USER_FILE = 'SendUserFile';

export interface SentCall {
	caption: string | null;
	render: boolean;
	files: { path: string; size: number | null }[];
}

const Input = z.looseObject({ files: z.array(z.string().min(1)).min(1), caption: z.string().optional(), display: z.string().optional() });
// The PostToolUse carries this as tool_response, one attachment per input path, each resolved against Claude Code's working directory.
const Live = z.looseObject({ attachments: z.array(z.looseObject({ path: z.string().min(1), size: z.number().int().min(0).optional() })) });
// History carries only the tool result text, which names each delivered file by its resolved path, and leaves out one whose upload failed.
const DELIVERED = /^ +(\/.*) → file_uuid: [0-9a-f-]+$/gm;
const TextBlocks = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));

function resultText(output: unknown): string {
	if (typeof output === 'string') return output;
	const blocks = TextBlocks.safeParse(output);
	return blocks.success ? blocks.data.map((block) => block.text ?? '').join('\n') : '';
}

// Claude Code resolves a relative input path against its working directory at the time of the call, which may no longer be the session's, so a reported path matches by equality, then by position when it reported one per input path, then by a unique suffix.
function matchByPathPlaceOrSuffix(paths: string[], input: string[], index: number, guess: string): number {
	const same = paths.indexOf(guess);
	if (same !== -1) return same;
	if (paths.length === input.length) return index;
	const relative = input[index]!;
	if (isAbsolute(relative)) return -1;
	const ends = paths.flatMap((path, at) => (path.endsWith(`/${normalize(relative)}`) ? [at] : []));
	return ends.length === 1 ? ends[0]! : -1;
}

export function sentCall(input: unknown, output: unknown, cwd: string): SentCall | null {
	const parsed = Input.safeParse(input);
	if (!parsed.success) return null;
	const { files, caption, display } = parsed.data;
	const live = Live.safeParse(output);
	const attachments = live.success ? live.data.attachments : [...resultText(output).matchAll(DELIVERED)].map((line) => ({ path: line[1]!, size: undefined }));
	const paths = attachments.map(({ path }) => path);
	return {
		caption: caption ?? null,
		render: display === 'render',
		files: files.map((file, index) => {
			const guess = isAbsolute(file) ? normalize(file) : resolve(cwd, file);
			const found = attachments[matchByPathPlaceOrSuffix(paths, files, index, guess)];
			return { path: found?.path ?? guess, size: found?.size ?? null };
		}),
	};
}
