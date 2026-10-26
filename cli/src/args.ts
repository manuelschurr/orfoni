import { isAbsolute, resolve } from 'node:path';
import { RequestId, type SessionSummary } from '@orfoni/protocol';

export type Command =
	| { name: 'list' }
	| { name: 'start'; dir: string; prompt?: string }
	| { name: 'send'; session: string; text: string }
	| { name: 'watch' | 'interrupt' | 'stop' | 'shell'; session: string }
	| { name: 'allow' | 'approve-plan'; requestId: RequestId }
	| { name: 'deny'; requestId: RequestId; message?: string }
	| { name: 'answer'; requestId: RequestId; answers: Record<string, string> };

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type Parsed = Result<{ via: string | null; command: Command }>;

interface Context {
	local: boolean;
	cwd: string;
}

interface Subcommand {
	usage: string;
	min: number;
	max: number;
	build(args: string[], context: Context): Result<{ command: Command }>;
}

function ok(command: Command): Result<{ command: Command }> {
	return { ok: true, command };
}

function session(name: 'watch' | 'interrupt' | 'stop' | 'shell'): Subcommand {
	return { usage: '<session>', min: 1, max: 1, build: ([s]) => ok({ name, session: s! }) };
}

function request(name: 'allow' | 'approve-plan'): Subcommand {
	return { usage: '<request>', min: 1, max: 1, build: ([r]) => ok({ name, requestId: RequestId.parse(r) }) };
}

function parseAnswers(pairs: string[]): Result<{ answers: Record<string, string> }> {
	const answers: Record<string, string> = {};
	for (const pair of pairs) {
		const at = pair.indexOf('=');
		if (at < 1 || at === pair.length - 1) return { ok: false, error: `answer ${pair} is not <question>=<label>` };
		const question = pair.slice(0, at);
		if (question in answers) return { ok: false, error: `answer ${question} given twice` };
		answers[question] = pair.slice(at + 1);
	}
	return { ok: true, answers };
}

const subcommands: Record<Command['name'], Subcommand> = {
	list: { usage: '', min: 0, max: 0, build: () => ok({ name: 'list' }) },
	start: {
		usage: '<dir> [prompt]',
		min: 1,
		max: 2,
		build: ([dir, prompt], { local, cwd }) => ok({ name: 'start', dir: local && !isAbsolute(dir!) ? resolve(cwd, dir!) : dir!, ...(prompt ? { prompt } : {}) }),
	},
	send: { usage: '<session> <text>', min: 2, max: 2, build: ([s, text]) => ok({ name: 'send', session: s!, text: text! }) },
	watch: session('watch'),
	interrupt: session('interrupt'),
	stop: session('stop'),
	shell: session('shell'),
	allow: request('allow'),
	'approve-plan': request('approve-plan'),
	deny: {
		usage: '<request> [message]',
		min: 1,
		max: 2,
		build: ([r, message]) => ok({ name: 'deny', requestId: RequestId.parse(r), ...(message ? { message } : {}) }),
	},
	answer: {
		usage: '<request> <question>=<label>...',
		min: 2,
		max: Infinity,
		build: ([r, ...pairs]) => {
			const parsed = parseAnswers(pairs);
			return parsed.ok ? ok({ name: 'answer', requestId: RequestId.parse(r), answers: parsed.answers }) : parsed;
		},
	},
};

export const usage = [
	'usage: orfoni [--via "<command>"] <subcommand>',
	...Object.entries(subcommands).map(([name, { usage }]) => `  ${name} ${usage}`.trimEnd()),
	'--via defaults to "orfoni-hub connect". A session argument accepts any unique prefix of the session id.',
].join('\n');

export function parseArgs(argv: string[], cwd: string): Parsed {
	let via: string | null = null;
	let rest = argv;
	if (rest[0] === '--via') {
		if (!rest[1]) return { ok: false, error: '--via needs a command' };
		via = rest[1];
		rest = rest.slice(2);
	}
	const [name, ...args] = rest;
	if (name === undefined) return { ok: false, error: 'missing subcommand' };
	if (!Object.hasOwn(subcommands, name)) return { ok: false, error: `unknown subcommand ${name}` };
	const subcommand = subcommands[name as Command['name']];
	if (args.length < subcommand.min || args.length > subcommand.max || args.slice(0, subcommand.min).some((arg) => arg === '')) {
		return { ok: false, error: subcommand.max === 0 ? `${name} takes no arguments` : `${name} needs ${subcommand.usage}` };
	}
	const built = subcommand.build(args, { local: via === null, cwd });
	return built.ok ? { ok: true, via, command: built.command } : built;
}

export function matchSession(sessions: SessionSummary[], prefix: string): Result<{ session: SessionSummary }> {
	const matches = sessions.filter((s) => s.id.startsWith(prefix));
	if (matches.length === 1) return { ok: true, session: matches[0]! };
	if (matches.length === 0) return { ok: false, error: `no session starts with ${prefix}` };
	return { ok: false, error: `${prefix} matches ${matches.length} sessions: ${matches.map((s) => s.id).join(', ')}` };
}
