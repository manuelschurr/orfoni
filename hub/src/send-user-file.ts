import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';

// Everything the hub knows about the formats of Claude Code's SendUserFile, measured on Claude Code 2.1.322, so that a change in them is fixed in the hub alone and not in the apps.
export const SEND_USER_FILE = 'SendUserFile';

// What one call sent: one file per path of its input, in that order.
export interface SentCall {
	caption: string | null;
	// The call asked for display: "render", so the card shows its images.
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

// Which of the paths Claude Code reported is the input path at `index`: the same path, else the one in the same place when it reported one per input path, as after Claude moved to another folder, else the only one that ends in a relative input path.
function reported(paths: string[], input: string[], index: number, guess: string): number {
	const same = paths.indexOf(guess);
	if (same !== -1) return same;
	if (paths.length === input.length) return index;
	const relative = input[index]!;
	if (isAbsolute(relative)) return -1;
	const ends = paths.flatMap((path, at) => (path.endsWith(`/${normalize(relative)}`) ? [at] : []));
	return ends.length === 1 ? ends[0]! : -1;
}

// Null when the input is not one of SendUserFile that this hub reads, and the chat then shows the call as any other tool. `cwd` resolves a relative path Claude Code reported no resolved path for.
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
			const found = attachments[reported(paths, files, index, guess)];
			return { path: found?.path ?? guess, size: found?.size ?? null };
		}),
	};
}
