import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ChatItem, ErrorCode, parseHubMessage, SessionSummary, type ClientRequest, type HubMessage, type SessionId } from '@orfoni/protocol';
import { matchSession, parseArgs, usage, type Command } from './args.js';
import { formatChatItem, formatSession } from './format.js';

type Method = ClientRequest['method'];
type Params<M extends Method> = Omit<Extract<ClientRequest, { method: M }>, 'id' | 'method'>;

const Started = z.object({ session: SessionSummary, needsTrust: z.boolean() });
const Opened = z.object({ session: SessionSummary, chat: z.array(ChatItem) });

class HubError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
	}
}

class Connection {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	private readonly listeners = new Set<(message: HubMessage) => void>();
	private readonly child;
	readonly closed: Promise<Error>;

	constructor(via: string) {
		this.child = spawn('/bin/sh', ['-c', via], { stdio: ['pipe', 'pipe', 'inherit'] });
		this.closed = new Promise((resolve) => {
			const fail = (error: Error) => {
				for (const { reject } of this.pending.values()) reject(error);
				this.pending.clear();
				resolve(error);
			};
			this.child.on('exit', () => fail(new Error('hub connection closed')));
			this.child.on('error', fail);
			// A write after the hub exits raises EPIPE here; the exit handler already reports the closed connection.
			this.child.stdin.on('error', () => {});
			createInterface({ input: this.child.stdout }).on('line', (line) => {
				try {
					this.receive(parseHubMessage(line));
				} catch (error) {
					fail(error as Error);
				}
			});
		});
	}

	request<M extends Method>(method: M, params: Params<M>): Promise<unknown> {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ id, method, ...params })}\n`);
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	listen(listener: (message: HubMessage) => void): void {
		this.listeners.add(listener);
	}

	close(): void {
		this.child.stdin.end();
		this.child.kill();
	}

	private receive(message: HubMessage): void {
		if (message.type !== 'response') {
			for (const listener of this.listeners) listener(message);
			return;
		}
		const request = this.pending.get(message.id);
		this.pending.delete(message.id);
		if (message.ok) request?.resolve(message.result);
		else request?.reject(new HubError(message.error.code, message.error.message));
	}
}

async function findSession(hub: Connection, prefix: string): Promise<SessionId> {
	const sessions = z.array(SessionSummary).parse(await hub.request('listSessions', {}));
	const match = matchSession(sessions, prefix);
	if (!match.ok) throw new Error(match.error);
	return match.session.id;
}

async function run(hub: Connection, command: Command): Promise<void> {
	switch (command.name) {
		case 'list': {
			const sessions = z.array(SessionSummary).parse(await hub.request('listSessions', {}));
			for (const session of sessions) console.log(formatSession(session));
			return;
		}
		case 'start': {
			const { session, needsTrust } = Started.parse(await hub.request('startSession', { projectDir: command.dir, prompt: command.prompt }));
			console.log(formatSession(session));
			if (needsTrust) {
				console.log(`Claude Code is waiting for you to trust ${session.projectDir}. Open the session's terminal with \`tmux -L orfoni attach -t orfoni-${session.id}\` and accept the prompt.`);
			}
			return;
		}
		case 'send':
			await hub.request('send', { sessionId: await findSession(hub, command.session), text: command.text });
			return;
		case 'watch': {
			const sessionId = await findSession(hub, command.session);
			let early: ChatItem[] | null = [];
			hub.listen((message) => {
				if (message.type !== 'chatItem' || message.sessionId !== sessionId) return;
				if (message.item.kind === 'assistant' && !message.item.done) return;
				if (early) early.push(message.item);
				else console.log(formatChatItem(message.item));
			});
			const { chat } = Opened.parse(await hub.request('openSession', { sessionId }));
			for (const item of [...chat, ...early]) console.log(formatChatItem(item));
			early = null;
			throw await hub.closed;
		}
		case 'allow':
			await hub.request('decide', { requestId: command.requestId, decision: { type: 'allow' } });
			return;
		case 'deny':
			await hub.request('decide', { requestId: command.requestId, decision: { type: 'deny', message: command.message } });
			return;
		case 'answer':
			await hub.request('decide', { requestId: command.requestId, decision: { type: 'answer', answers: command.answers } });
			return;
		case 'approve-plan':
			await hub.request('decide', { requestId: command.requestId, decision: { type: 'approve_plan' } });
			return;
		case 'interrupt':
			await hub.request('interrupt', { sessionId: await findSession(hub, command.session) });
			return;
		case 'stop':
			await hub.request('stopSession', { sessionId: await findSession(hub, command.session) });
			return;
		case 'shell':
			console.log(JSON.stringify(await hub.request('openShell', { sessionId: await findSession(hub, command.session) })));
			return;
	}
}

const parsed = parseArgs(process.argv.slice(2), process.cwd());
if (!parsed.ok) {
	console.error(`orfoni: ${parsed.error}\n${usage}`);
	process.exit(1);
}
const hub = new Connection(parsed.via ?? 'orfoni-hub connect');
try {
	await Promise.race([run(hub, parsed.command), hub.closed.then((error) => Promise.reject(error))]);
} catch (error) {
	console.error(error instanceof HubError ? `${error.code}: ${error.message}` : `orfoni: ${(error as Error).message}`);
	process.exitCode = 1;
} finally {
	hub.close();
}
