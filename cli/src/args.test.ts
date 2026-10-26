import { describe, expect, test } from 'vitest';
import { SessionId, type SessionSummary } from '@orfoni/protocol';
import { matchSession, parseArgs } from './args.js';

const cwd = '/home/me';

describe('parseArgs', () => {
	test('parses list and leaves via unset', () => {
		expect(parseArgs(['list'], cwd)).toEqual({ ok: true, via: null, command: { name: 'list' } });
	});

	test('takes --via before the subcommand', () => {
		expect(parseArgs(['--via', 'ssh vps orfoni-hub connect', 'list'], cwd)).toEqual({ ok: true, via: 'ssh vps orfoni-hub connect', command: { name: 'list' } });
	});

	test('resolves a relative start folder against the working directory when the hub is local', () => {
		expect(parseArgs(['start', 'proj', 'fix it'], cwd)).toEqual({ ok: true, via: null, command: { name: 'start', dir: '/home/me/proj', prompt: 'fix it' } });
	});

	test('passes a start folder through unchanged when the hub is reached with --via', () => {
		expect(parseArgs(['--via', 'ssh vps orfoni-hub connect', 'start', 'proj'], cwd)).toEqual({
			ok: true,
			via: 'ssh vps orfoni-hub connect',
			command: { name: 'start', dir: 'proj' },
		});
	});

	test('parses the session subcommands', () => {
		expect(parseArgs(['send', '0b9', 'hello there'], cwd)).toEqual({ ok: true, via: null, command: { name: 'send', session: '0b9', text: 'hello there' } });
		for (const name of ['watch', 'interrupt', 'stop', 'shell', 'rm'] as const) {
			expect(parseArgs([name, '0b9'], cwd)).toEqual({ ok: true, via: null, command: { name, session: '0b9' } });
		}
	});

	test('parses the request subcommands', () => {
		expect(parseArgs(['allow', 'r1'], cwd)).toEqual({ ok: true, via: null, command: { name: 'allow', requestId: 'r1' } });
		expect(parseArgs(['deny', 'r1'], cwd)).toEqual({ ok: true, via: null, command: { name: 'deny', requestId: 'r1' } });
		expect(parseArgs(['deny', 'r1', 'use pnpm'], cwd)).toEqual({ ok: true, via: null, command: { name: 'deny', requestId: 'r1', message: 'use pnpm' } });
		expect(parseArgs(['approve-plan', 'r1'], cwd)).toEqual({ ok: true, via: null, command: { name: 'approve-plan', requestId: 'r1' } });
	});

	test('parses answers as question=label pairs, splitting at the first =', () => {
		expect(parseArgs(['answer', 'r1', 'Which database?=Postgres', 'Flags?=a=b'], cwd)).toEqual({
			ok: true,
			via: null,
			command: { name: 'answer', requestId: 'r1', answers: { 'Which database?': 'Postgres', 'Flags?': 'a=b' } },
		});
	});

	test.each([
		[[], 'missing subcommand'],
		[['--via'], '--via needs a command'],
		[['frobnicate'], 'unknown subcommand frobnicate'],
		[['send', '0b9'], 'send needs <session> <text>'],
		[['send', '0b9', 'a', 'b'], 'send needs <session> <text>'],
		[['list', 'extra'], 'list takes no arguments'],
		[['answer', 'r1'], 'answer needs <request> <question>=<label>...'],
		[['answer', 'r1', 'no-equals'], 'answer no-equals is not <question>=<label>'],
		[['answer', 'r1', '=label'], 'answer =label is not <question>=<label>'],
		[['answer', 'r1', 'Q=a', 'Q=b'], 'answer Q given twice'],
		[['start', ''], 'start needs <dir> [prompt]'],
		[['rm'], 'rm needs <session>'],
	])('rejects %j', (argv, error) => {
		expect(parseArgs(argv, cwd)).toEqual({ ok: false, error });
	});
});

describe('matchSession', () => {
	const session = (id: string): SessionSummary => ({ id: SessionId.parse(id), projectDir: '/p', title: null, claudeSessionId: null, state: 'idle', stateSince: 0 });
	const sessions = [session('0b9c1f2e'), session('0b1d77aa'), session('7f00ee11')];

	test('returns the one session whose id starts with the prefix', () => {
		expect(matchSession(sessions, '0b9')).toEqual({ ok: true, session: sessions[0] });
		expect(matchSession(sessions, '7f00ee11')).toEqual({ ok: true, session: sessions[2] });
	});

	test('rejects a prefix that matches no session', () => {
		expect(matchSession(sessions, 'zz')).toEqual({ ok: false, error: 'no session starts with zz' });
	});

	test('rejects a prefix that matches more than one session', () => {
		expect(matchSession(sessions, '0b')).toEqual({ ok: false, error: '0b matches 2 sessions: 0b9c1f2e, 0b1d77aa' });
	});
});
