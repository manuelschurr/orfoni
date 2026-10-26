import { once } from 'node:events';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { listenClients } from './client-server.js';
import { createHookServer } from './hook-server.js';
import { Hub } from './hub.js';
import { createTmux, runTmux } from './tmux.js';

function socketPath(): string {
	return join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'orfoni', 'hub.sock');
}

function hookPort(): number {
	const port = Number(process.env.ORFONI_HOOK_PORT ?? 47380);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ORFONI_HOOK_PORT must be a port number, got ${process.env.ORFONI_HOOK_PORT}`);
	return port;
}

async function daemon(): Promise<void> {
	const log = (line: string) => console.error(line);
	const port = hookPort();
	const hub = await Hub.start({
		tmux: createTmux(runTmux(process.env.ORFONI_TMUX_SOCKET ?? 'orfoni')),
		hookPort: port,
		stateDir: join(homedir(), '.local/state/orfoni'),
		claudeConfigPath: join(homedir(), '.claude.json'),
		shell: process.env.SHELL ?? '/bin/bash',
		readHistory: (claudeSessionId, projectDir) => getSessionMessages(claudeSessionId, { dir: projectDir, includeSystemMessages: true }),
		log,
	});
	const hooks = createHookServer(hub, log);
	hooks.listen(port, '127.0.0.1');
	await once(hooks, 'listening');
	const path = socketPath();
	await listenClients(hub, path);
	log(`orfoni-hub: hooks on 127.0.0.1:${port}, clients on ${path}`);
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
}

function bridge(): void {
	const socket = connect(socketPath());
	socket.on('connect', () => {
		process.stdin.pipe(socket);
		socket.pipe(process.stdout);
	});
	socket.on('error', (error) => {
		console.error(`orfoni-hub connect: ${error.message}`);
		process.exit(1);
	});
	socket.on('close', () => process.exit(0));
	process.stdout.on('error', () => process.exit(0));
}

const command = process.argv[2];
if (command === 'daemon') await daemon();
else if (command === 'connect') bridge();
else {
	console.error('usage: orfoni-hub daemon | orfoni-hub connect');
	process.exit(2);
}
