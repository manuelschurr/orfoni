import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { listenClients } from './client-server.js';
import { listenHooks } from './hook-server.js';
import { Hub } from './hub.js';
import { claudeClient, readApiKey, SUMMARY_MODEL } from './summaries.js';
import { createTmux, runTmux } from './tmux.js';

function runtimePath(name: string): string {
	return join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'orfoni', name);
}

async function daemon(): Promise<void> {
	const log = (line: string) => console.error(line);
	const hookSocket = runtimePath('hooks.sock');
	const hub = await Hub.start({
		tmux: createTmux(runTmux(process.env.ORFONI_TMUX_SOCKET ?? 'orfoni')),
		hookSocket,
		stateDir: join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'orfoni'),
		claudeConfigPath: join(homedir(), '.claude.json'),
		home: homedir(),
		shell: process.env.SHELL ?? '/bin/bash',
		readHistory: (claudeSessionId, projectDir) => getSessionMessages(claudeSessionId, { dir: projectDir, includeSystemMessages: true }),
		summaries: {
			model: process.env.ORFONI_SUMMARY_MODEL || SUMMARY_MODEL,
			apiKey: () => readApiKey(join(homedir(), '.config/orfoni/anthropic-api-key'), process.env.ANTHROPIC_API_KEY),
			client: (apiKey) => claudeClient(apiKey),
		},
		systemRoot: '/',
		log,
	});
	await listenHooks(hub, hookSocket, log);
	const clientSocket = runtimePath('hub.sock');
	await listenClients(hub, clientSocket);
	log(`orfoni-hub: hooks on ${hookSocket}, clients on ${clientSocket}`);
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
}

function bridge(): void {
	const socket = connect(runtimePath('hub.sock'));
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
