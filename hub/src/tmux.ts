import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type Run = (args: string[], stdin?: string) => Promise<string>;

export interface Pane {
	name: string;
	panePid: number;
	paneDead: boolean;
}

export interface Tmux {
	newSession(name: string, cwd: string, env: Record<string, string>, command: string[]): Promise<void>;
	killSession(name: string): Promise<void>;
	listSessions(): Promise<Pane[]>;
	submit(session: string, text: string, images?: string[]): Promise<void>;
	sendKeys(session: string, ...keys: string[]): Promise<void>;
	capturePane(session: string): Promise<string>;
}

// A bare -t name also matches a session whose name merely starts with it, such as that session's shell orfoni-<id>-sh1.
export function sessionTarget(name: string): string {
	return `=${name}`;
}

function paneTarget(name: string): string {
	return `=${name}:`;
}

const PASTE_LIMIT = 400;

export class AttachError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AttachError';
	}
}

const ATTACH_TIMEOUT_MS = 30_000;
const ATTACH_POLL_MS = 50;

// The input box is the last line that starts with Claude Code's prompt, with the lines that continue it down to the rule under the box.
function attachedImages(screen: string): number {
	const lines = screen.split('\n');
	const start = lines.findLastIndex((line) => line.startsWith('❯'));
	if (start === -1) return 0;
	const end = lines.findIndex((line, index) => index > start && line.startsWith('─'));
	return lines.slice(start, end === -1 ? undefined : end).join('\n').match(/\[Image #\d+\]/g)?.length ?? 0;
}

function pieces(line: string): string[] {
	const points = [...line];
	const result: string[] = [];
	for (let start = 0; start < points.length; start += PASTE_LIMIT) result.push(points.slice(start, start + PASTE_LIMIT).join(''));
	return result;
}

export function runTmux(socket: string): Run {
	return (args, stdin) =>
		new Promise((resolve, reject) => {
			const child = execFile('tmux', ['-L', socket, ...args], (error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			});
			// Most tmux commands exit without reading stdin, so the write can fail with EPIPE; the exit status above still reports how tmux did.
			child.stdin?.on('error', () => {});
			child.stdin?.end(stdin ?? '');
		});
}

const NO_PANES = /no server running|error connecting to|no current target/;

export function createTmux(run: Run): Tmux {
	return {
		async newSession(name, cwd, env, command) {
			const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
			await run(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...envArgs, '--', ...command]);
		},
		async killSession(name) {
			await run(['kill-session', '-t', sessionTarget(name)]);
		},
		async listSessions() {
			const output = await run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}']).catch((error: Error) => {
				if (NO_PANES.test(error.message)) return '';
				throw error;
			});
			return output
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const [name = '', pid = '', dead = ''] = line.split('\t');
					return { name, panePid: Number(pid), paneDead: dead === '1' };
				});
		},
		// Claude Code collapses a paste of more than 3 lines or 800 characters into [Pasted text #N] and tells Claude its content may not come from the user, so each line goes in as small newline-free pastes, with Ctrl+J between lines. Enter right after a backslash inserts a newline instead of submitting, and Claude Code trims the space added after one.
		// An image path pasted on its own becomes an attached [Image #N], which leaves no space before the text that follows. Claude Code reads and shrinks the image first, from milliseconds to seconds, and an Enter pressed before that sends the message without it.
		async submit(session, text, images = []) {
			const paste = async (piece: string) => {
				const buffer = `orfoni-${randomUUID()}`;
				await run(['load-buffer', '-b', buffer, '-'], piece);
				await run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneTarget(session)]);
			};
			if (images.length > 0) {
				const attached = async () => attachedImages(await run(['capture-pane', '-p', '-t', paneTarget(session)]));
				const expected = (await attached()) + images.length;
				for (const image of images) await paste(image);
				const deadline = Date.now() + ATTACH_TIMEOUT_MS;
				while ((await attached()) < expected) {
					if (Date.now() >= deadline) throw new AttachError(`Claude Code did not attach the images within ${ATTACH_TIMEOUT_MS / 1000} s`);
					await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
				}
			}
			const typed = images.length > 0 && text !== '' ? ` ${text}` : text;
			const lines = (typed.endsWith('\\') ? `${typed} ` : typed).split('\n');
			for (const [index, line] of lines.entries()) {
				if (index > 0) await run(['send-keys', '-t', paneTarget(session), 'C-j']);
				for (const piece of pieces(line)) await paste(piece);
			}
			await run(['send-keys', '-t', paneTarget(session), 'Enter']);
		},
		async sendKeys(session, ...keys) {
			await run(['send-keys', '-t', paneTarget(session), ...keys]);
		},
		capturePane(session) {
			return run(['capture-pane', '-p', '-t', paneTarget(session)]);
		},
	};
}
