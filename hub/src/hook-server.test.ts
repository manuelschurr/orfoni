import { execFile } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { createHookServer } from './hook-server.js';
import type { HookResponse } from './requests.js';
import { hookSettings } from './settings.js';

let server: Server;
let logs: string[];
let calls: { header: string | undefined; body: unknown }[];

async function serve(answer: () => Promise<HookResponse>): Promise<number> {
	logs = [];
	calls = [];
	server = createHookServer(
		{
			hook: (header, body) => {
				calls.push({ header, body });
				return answer();
			},
		},
		(line) => logs.push(line),
	);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return (server.address() as AddressInfo).port;
}

function runHookCommand(port: number, hook: 'Stop' | 'PermissionRequest', body: object): Promise<string> {
	const entry = (hookSettings(port) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks[hook]![0]!.hooks[0]!;
	return new Promise((resolve, reject) => {
		const child = execFile('/bin/sh', ['-c', entry.command], { env: { ...process.env, ORFONI_SESSION: 'session-1' } }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
		child.stdin?.end(JSON.stringify(body));
	});
}

const never = () => new Promise<HookResponse>(() => {});

afterEach(() => {
	server.closeAllConnections();
	server.close();
});

describe('hook server', () => {
	test('the curl hook command gets an empty answer at once, before the hub has handled the hook', async () => {
		const port = await serve(never);
		const body = { hook_event_name: 'Stop', session_id: 'c1', last_assistant_message: 'done' };
		expect(await runHookCommand(port, 'Stop', body)).toBe('');
		expect(calls).toEqual([{ header: 'session-1', body }]);
	});

	test('a PermissionRequest is held until the hub answers, and curl prints the answer', async () => {
		let answer: (response: HookResponse) => void = () => {};
		const port = await serve(() => new Promise((resolve) => (answer = resolve)));
		let printed: string | undefined;
		const body = { hook_event_name: 'PermissionRequest', session_id: 'c1', tool_name: 'Write', tool_input: {} };
		const done = runHookCommand(port, 'PermissionRequest', body).then((stdout) => (printed = stdout));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls).toEqual([{ header: 'session-1', body }]);
		expect(printed).toBeUndefined();
		const decision: HookResponse = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
		answer(decision);
		await done;
		expect(JSON.parse(printed!)).toEqual(decision);
	});

	test('a body that is not JSON gets an empty 200 and a log line', async () => {
		const port = await serve(never);
		const response = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: 'not json' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
		expect(calls).toEqual([]);
		expect(logs).toHaveLength(1);
	});

	test('anything but POST /hook gets 404', async () => {
		const port = await serve(never);
		expect((await fetch(`http://127.0.0.1:${port}/hook`)).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', body: '{}' })).status).toBe(404);
	});
});
