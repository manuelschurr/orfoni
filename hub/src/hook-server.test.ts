import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { listenHooks } from './hook-server.js';
import type { HookResponse } from './requests.js';
import { hookSettings } from './settings.js';

let server: Server | undefined;
let logs: string[];
let calls: { header: string | undefined; body: unknown; closed: AbortSignal | undefined }[];
let statusLines: { header: string | undefined; text: string }[];

function socketPath(): string {
	return join(mkdtempSync(join(tmpdir(), 'orfoni-hooks-')), 'orfoni', 'hooks.sock');
}

async function serve(answer: () => Promise<HookResponse>, path = socketPath(), status = (_header: string | undefined, _text: string) => {}): Promise<string> {
	logs = [];
	calls = [];
	statusLines = [];
	server = await listenHooks(
		{
			hook: (header, body, closed) => {
				calls.push({ header, body, closed });
				return answer();
			},
			status: (header, text) => {
				statusLines.push({ header, text });
				status(header, text);
			},
		},
		path,
		(line) => logs.push(line),
	);
	return path;
}

function runStatusLine(path: string, original: string | null, input: string): Promise<{ stdout: string; ms: number }> {
	const { command } = (hookSettings(path, original) as { statusLine: { command: string } }).statusLine;
	const startedAt = performance.now();
	return new Promise((resolve, reject) => {
		const child = execFile('/bin/sh', ['-c', command], { env: { ...process.env, ORFONI_SESSION: 'session-1' } }, (error, stdout) =>
			error ? reject(error) : resolve({ stdout, ms: performance.now() - startedAt }),
		);
		child.stdin?.end(input);
	});
}

function runHookCommand(path: string, hook: 'Stop' | 'PermissionRequest', body: object): Promise<string> {
	const entry = (hookSettings(path, null) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks[hook]![0]!.hooks[0]!;
	return new Promise((resolve, reject) => {
		const child = execFile('/bin/sh', ['-c', entry.command], { env: { ...process.env, ORFONI_SESSION: 'session-1' } }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
		child.stdin?.end(JSON.stringify(body));
	});
}

function send(path: string, method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ socketPath: path, method, path: url }, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
		});
		request.on('error', reject);
		request.end(body);
	});
}

const never = () => new Promise<HookResponse>(() => {});

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	if (!check()) throw new Error('condition never became true');
}

afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

describe('hook server', () => {
	test('the curl hook command gets an empty answer at once, before the hub has handled the hook', async () => {
		const path = await serve(never);
		const body = { hook_event_name: 'Stop', session_id: 'c1', last_assistant_message: 'done' };
		expect(await runHookCommand(path, 'Stop', body)).toBe('');
		expect(calls).toMatchObject([{ header: 'session-1', body }]);
	});

	test('a PermissionRequest is held until the hub answers, and curl prints the answer', async () => {
		let answer: (response: HookResponse) => void = () => {};
		const path = await serve(() => new Promise((resolve) => (answer = resolve)));
		let printed: string | undefined;
		const body = { hook_event_name: 'PermissionRequest', session_id: 'c1', tool_name: 'Write', tool_input: {} };
		const done = runHookCommand(path, 'PermissionRequest', body).then((stdout) => (printed = stdout));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls).toMatchObject([{ header: 'session-1', body }]);
		expect(printed).toBeUndefined();
		const decision: HookResponse = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
		answer(decision);
		await done;
		expect(JSON.parse(printed!)).toEqual(decision);
	});

	test('killing the curl of a held PermissionRequest, as Claude Code does on a terminal No or Escape, tells the hub the connection closed', async () => {
		const path = await serve(never);
		const entry = (hookSettings(path, null) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.PermissionRequest![0]!.hooks[0]!;
		const child = spawn('/bin/sh', ['-c', entry.command], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ORFONI_SESSION: 'session-1' } });
		child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'c1', tool_name: 'Write', tool_input: {} }));
		await until(() => calls.length === 1);
		expect(calls[0]!.closed?.aborted).toBe(false);
		process.kill(-child.pid!, 'SIGTERM');
		await until(() => calls[0]!.closed?.aborted === true);
	});

	test('a hook answered at once never reports a closed connection', async () => {
		const path = await serve(never);
		await runHookCommand(path, 'Stop', { hook_event_name: 'Stop', session_id: 'c1' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls[0]!.closed?.aborted).toBe(false);
	});

	test('the socket lives in a directory only its owner can enter, even one that existed before', async () => {
		const path = socketPath();
		mkdirSync(join(path, '..'), { mode: 0o755 });
		chmodSync(join(path, '..'), 0o755);
		await serve(never, path);
		expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
	});

	test('a body that is not JSON gets an empty 200 and a log line', async () => {
		const path = await serve(never);
		expect(await send(path, 'POST', '/hook', 'not json')).toEqual({ status: 200, text: '' });
		expect(calls).toEqual([]);
		expect(logs).toHaveLength(1);
	});

	test('anything but POST /hook and POST /status gets 404', async () => {
		const path = await serve(never);
		expect((await send(path, 'GET', '/hook')).status).toBe(404);
		expect((await send(path, 'GET', '/status')).status).toBe(404);
		expect((await send(path, 'POST', '/other', '{}')).status).toBe(404);
	});
});

describe('status line', () => {
	const input = '{"model":{"id":"claude-haiku-5-5","display_name":"Haiku 5.5"},"effort":{"level":"low"}}';

	test('the status line command hands its input to the hub with the session header, and prints what the original command prints for it', async () => {
		const path = await serve(never);
		const { stdout } = await runStatusLine(path, `sed 's/^/shown: /'`, input);
		expect(stdout).toBe(`shown: ${input}`);
		expect(statusLines).toEqual([{ header: 'session-1', text: input }]);
	});

	test('an original command written as a small script, with quotes, separators, and a comment, gets the input too', async () => {
		const path = await serve(never);
		const { stdout } = await runStatusLine(path, `x=$(cat) && printf '%s\\n' "it's $x" | tr a-z A-Z; echo done # a 'comment'`, input);
		expect(stdout).toBe(`IT'S ${input.toUpperCase()}\ndone\n`);
	});

	test('without an original command the status line command prints nothing', async () => {
		const path = await serve(never);
		expect((await runStatusLine(path, null, input)).stdout).toBe('');
		expect(statusLines).toEqual([{ header: 'session-1', text: input }]);
	});

	test('with the hub down, the original line prints at once', async () => {
		const { stdout, ms } = await runStatusLine(socketPath(), 'cat', input);
		expect(stdout).toBe(input);
		expect(ms).toBeLessThan(900);
	});

	test('a hub that never answers holds the original line back by about a second at most', async () => {
		const path = socketPath();
		mkdirSync(join(path, '..'), { recursive: true });
		const silent = createNetServer(() => {});
		await new Promise<void>((resolve) => silent.listen(path, resolve));
		try {
			const { stdout, ms } = await runStatusLine(path, 'cat', input);
			expect(stdout).toBe(input);
			expect(ms).toBeLessThan(3000);
		} finally {
			silent.close();
		}
	});

	test('a status line the hub fails on still gets its empty answer, and the failure is logged', async () => {
		const path = await serve(never, socketPath(), () => {
			throw new Error('broken');
		});
		expect(await send(path, 'POST', '/status', input)).toEqual({ status: 200, text: '' });
		expect(statusLines).toEqual([{ header: undefined, text: input }]);
		expect(logs).toEqual([expect.stringContaining('broken')]);
	});
});
