#!/usr/bin/env node
// Lets the app's browser build reach the hub and tmux on this machine, for development and the Playwright checks only.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const HOST = '127.0.0.1';
const port = Number(process.env.ORFONI_BRIDGE_PORT ?? 4790);
const hubCommand = process.env.ORFONI_HUB_COMMAND ?? '"$HOME/.local/bin/orfoni-hub" connect';
const tmuxSocket = process.env.ORFONI_TMUX_SOCKET ?? 'orfoni';
const origins = new Set((process.env.ORFONI_BRIDGE_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','));
const TARGET = /^=orfoni-[0-9a-f-]+(-sh[0-9]+)?$/;
// Any local account can reach 127.0.0.1, and a terminal here is a shell as this user, so each connection must carry this start's token.
const token = Buffer.from(process.env.ORFONI_BRIDGE_TOKEN || randomBytes(32).toString('base64url'));

function carriesToken(url) {
	const given = Buffer.from(url.searchParams.get('token') ?? '');
	return given.length === token.length && timingSafeEqual(given, token);
}

function size(value) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 && n <= 1000 ? n : null;
}

function reason(text) {
	return Buffer.from(text).subarray(0, 120).toString();
}

function relayHub(ws) {
	const hub = spawn('/bin/sh', ['-c', `exec ${hubCommand}`], { stdio: ['pipe', 'pipe', 'inherit'] });
	hub.stdout.setEncoding('utf8');
	hub.stdout.on('data', (chunk) => ws.send(chunk));
	hub.stdin.on('error', () => {});
	hub.on('exit', (code, signal) => ws.close(1011, reason(`the hub command exited with ${signal ?? code}`)));
	hub.on('error', (error) => ws.close(1011, reason(error.message)));
	ws.on('message', (data, isBinary) => {
		if (!isBinary) hub.stdin.write(data.toString());
	});
	ws.on('close', () => {
		hub.stdin.end();
		hub.kill();
	});
}

function relayTerminal(ws, target, cols, rows) {
	const env = { ...process.env, TERM: 'xterm-256color' };
	// tmux refuses to attach from inside another tmux client.
	delete env.TMUX;
	const term = pty.spawn('tmux', ['-u', '-L', tmuxSocket, 'attach', '-t', target], { name: 'xterm-256color', cols, rows, cwd: homedir(), env, encoding: null });
	term.onData((data) => ws.send(data));
	term.onExit(({ exitCode }) => ws.close(1000, reason(`tmux exited with ${exitCode}`)));
	ws.on('message', (data, isBinary) => {
		if (isBinary) {
			term.write(data);
			return;
		}
		try {
			const [c, r] = JSON.parse(data.toString()).resize ?? [];
			if (size(c) && size(r)) term.resize(c, r);
		} catch {
			ws.close(1003, 'expected {"resize":[cols,rows]}');
		}
	});
	ws.on('close', () => term.kill());
}

const sockets = new WebSocketServer({ noServer: true });
const server = createServer((request, response) => {
	response.writeHead(request.url === '/' ? 200 : 404, { 'content-type': 'text/plain' }).end('orfoni development bridge\n');
});

server.on('upgrade', (request, socket, head) => {
	const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
	// Browsers always send Origin, so this keeps web pages other than the app from driving the hub and tmux.
	if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) return refuse('403 Forbidden');
	const url = new URL(request.url ?? '/', `http://${HOST}`);
	if (!carriesToken(url)) return refuse('401 Unauthorized');
	if (url.pathname === '/hub') {
		sockets.handleUpgrade(request, socket, head, relayHub);
		return;
	}
	if (url.pathname !== '/terminal') return refuse('404 Not Found');
	const target = url.searchParams.get('target') ?? '';
	const cols = size(url.searchParams.get('cols'));
	const rows = size(url.searchParams.get('rows'));
	if (!TARGET.test(target) || !cols || !rows) return refuse('400 Bad Request');
	sockets.handleUpgrade(request, socket, head, (ws) => relayTerminal(ws, target, cols, rows));
});

server.listen(port, HOST, () => {
	console.error(`orfoni dev bridge on ws://${HOST}:${port}`);
	if (!process.env.ORFONI_BRIDGE_TOKEN) console.error(`open the app at http://127.0.0.1:5173/?transport=ws&token=${token}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
