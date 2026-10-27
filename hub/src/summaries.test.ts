import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionId } from '@orfoni/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { claudeClient, readApiKey, Summarizer, type ApiKey, type SummaryClient, type SummaryInput, type SummaryReply } from './summaries.js';

const T0 = Date.parse('2026-10-26T11:00:00.000Z');
const KEY = 'sk-ant-api03-secret-test-key';
const a = SessionId.parse('session-a');
const b = SessionId.parse('session-b');

const reply = (about: string, status: string, inputTokens = 1000, outputTokens = 50): SummaryReply => ({ kind: 'summary', about, status, usage: { inputTokens, outputTokens } });

interface Call {
	apiKey: string;
	model: string;
	prompt: string;
	answer(reply: SummaryReply | Error): void;
}

let calls: Call[];
let logs: string[];
let summaries: { sessionId: SessionId; about: string; status: string; at: number }[];
let apiKey: ApiKey;
let inputs: Map<SessionId, SummaryInput>;
let summarizer: Summarizer;

function client(apiKey: string): SummaryClient {
	return ({ model, prompt }) =>
		new Promise((resolve, reject) => calls.push({ apiKey, model, prompt, answer: (r) => (r instanceof Error ? reject(r) : resolve(r)) }));
}

function makeSummarizer(budget: { day: string; requests: number; spentUsd: number } | null = null) {
	summarizer = new Summarizer({
		model: 'claude-haiku-5-5',
		apiKey: async () => apiKey,
		client,
		input: async (sessionId) => inputs.get(sessionId) ?? null,
		summarized: (sessionId, summary) => summaries.push({ sessionId, ...summary }),
		budget,
		budgetChanged: () => {},
		log: (line) => logs.push(line),
	});
	return summarizer;
}

function input(changes: Partial<SummaryInput> = {}): SummaryInput {
	return { title: 'Notes', folder: 'orfoni', userMessages: ['write the notes'], reply: 'Wrote the notes.', ...changes };
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(T0);
	calls = [];
	logs = [];
	summaries = [];
	apiKey = { key: KEY };
	inputs = new Map([
		[a, input()],
		[b, input({ title: 'Other' })],
	]);
});

afterEach(() => {
	summarizer.close();
	vi.useRealTimers();
});

describe('Summarizer', () => {
	test('asks the model with the key and hands back about and status with the time it was written', async () => {
		makeSummarizer().request(a);
		await settle();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ apiKey: KEY, model: 'claude-haiku-5-5' });
		vi.setSystemTime(T0 + 1500);
		calls[0]!.answer(reply('Writing notes', 'Done, the notes are written.'));
		await settle();
		expect(summaries).toEqual([{ sessionId: a, about: 'Writing notes', status: 'Done, the notes are written.', at: T0 + 1500 }]);
	});

	test('requests within 20 s of the last one collapse into one, sent 20 s after it with the newest input', async () => {
		makeSummarizer().request(a);
		await settle();
		calls[0]!.answer(reply('one', 'one'));
		await vi.advanceTimersByTimeAsync(5000);
		summarizer.request(a);
		await vi.advanceTimersByTimeAsync(5000);
		inputs.set(a, input({ reply: 'the newest reply' }));
		summarizer.request(a);
		await vi.advanceTimersByTimeAsync(9999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.prompt).toContain('the newest reply');
	});

	test('keeps one request per session in flight, and a request made meanwhile goes out once it returns', async () => {
		makeSummarizer().request(a);
		await settle();
		await vi.advanceTimersByTimeAsync(30_000);
		summarizer.request(a);
		summarizer.request(a);
		await settle();
		expect(calls).toHaveLength(1);
		calls[0]!.answer(reply('one', 'one'));
		await settle();
		expect(calls).toHaveLength(2);
	});

	test('each session has its own 20 s window', async () => {
		makeSummarizer().request(a);
		summarizer.request(b);
		await settle();
		expect(calls).toHaveLength(2);
	});

	test('stops after 1,000 summaries in a day, logs that once, and starts again the next day', async () => {
		const ids = Array.from({ length: 1001 }, (_, index) => SessionId.parse(`s-${index}`));
		for (const id of ids) inputs.set(id, input());
		makeSummarizer();
		for (const id of ids) summarizer.request(id);
		await settle();
		for (const call of calls) call.answer(reply('x', 'y', 10, 10));
		await settle();
		expect(calls).toHaveLength(1000);
		expect(logs).toEqual([expect.stringContaining('until tomorrow')]);
		summarizer.request(a);
		await settle();
		expect(calls).toHaveLength(1000);
		vi.setSystemTime(new Date(2026, 9, 27, 0, 0, 1));
		summarizer.request(a);
		await settle();
		expect(calls).toHaveLength(1001);
	});

	test('stops once the estimated spend of the day reaches $2, priced at Haiku 5.5 rates', async () => {
		makeSummarizer().request(a);
		await settle();
		calls[0]!.answer(reply('x', 'y', 10_000_000, 2_000_000));
		await settle();
		expect((await summarizer.status()).spentTodayUsd).toBeCloseTo(2);
		summarizer.request(b);
		await settle();
		expect(calls).toHaveLength(1);
		expect(logs).toEqual([expect.stringContaining('until tomorrow')]);
	});

	test('a day that already spent its budget before a restart stays stopped', async () => {
		makeSummarizer({ day: '2026-10-26', requests: 1000, spentUsd: 0.5 }).request(a);
		await settle();
		expect(calls).toHaveLength(0);
		expect((await summarizer.status()).spentTodayUsd).toBe(0.5);
	});

	test('a budget from an earlier day counts nothing today', async () => {
		makeSummarizer({ day: '2026-10-25', requests: 1000, spentUsd: 2 }).request(a);
		await settle();
		expect(calls).toHaveLength(1);
		expect((await summarizer.status()).spentTodayUsd).toBe(0);
	});

	test('a refusal keeps the previous summary, counts its spend, and is logged', async () => {
		makeSummarizer().request(a);
		await settle();
		calls[0]!.answer({ kind: 'declined', reason: 'the model refused (general_harms)', usage: { inputTokens: 1_000_000, outputTokens: 0 } });
		await settle();
		expect(summaries).toEqual([]);
		expect(logs).toEqual([expect.stringContaining('the model refused (general_harms)')]);
		expect((await summarizer.status()).spentTodayUsd).toBeCloseTo(0.1);
	});

	test('an API error keeps the previous summary and is logged once, without the key', async () => {
		makeSummarizer().request(a);
		summarizer.request(b);
		await settle();
		for (const call of calls) call.answer(new Error(`401 invalid x-api-key ${KEY}`));
		await settle();
		expect(summaries).toEqual([]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('invalid x-api-key');
		expect(logs[0]).not.toContain(KEY);
	});

	test('without a key no request goes out, it is logged once, and status reports summaries off', async () => {
		apiKey = { missing: 'set ANTHROPIC_API_KEY or write the key to ~/.config/orfoni/anthropic-api-key' };
		makeSummarizer().request(a);
		summarizer.request(b);
		await settle();
		expect(calls).toEqual([]);
		expect(logs).toEqual([expect.stringContaining('ANTHROPIC_API_KEY')]);
		expect(await summarizer.status()).toEqual({ enabled: false, spentTodayUsd: 0 });
	});

	test('a key that appears later turns summaries on without a restart', async () => {
		apiKey = { missing: 'no key' };
		makeSummarizer().request(a);
		await settle();
		apiKey = { key: KEY };
		await vi.advanceTimersByTimeAsync(20_000);
		summarizer.request(a);
		await settle();
		expect(calls).toHaveLength(1);
		expect(await summarizer.status()).toEqual({ enabled: true, spentTodayUsd: 0 });
	});

	test('the input is the title, the folder, the last 6 user messages, and the reply', async () => {
		inputs.set(a, input({ userMessages: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], reply: 'the final reply' }));
		makeSummarizer().request(a);
		await settle();
		const { prompt } = calls[0]!;
		for (const text of ['Notes', 'orfoni', 'm3', 'm8', 'the final reply']) expect(prompt).toContain(text);
		expect(prompt).not.toMatch(/\bm[12]\b/);
	});

	test('a long input is cut to 8,000 characters, keeping the start and end of every part', async () => {
		const long = (tag: string, length: number) => `${tag}-start ${'x'.repeat(length)} ${tag}-end`;
		const messages = ['short question', ...Array.from({ length: 5 }, (_, index) => long(`m${index}`, 5000))];
		inputs.set(a, input({ userMessages: messages, reply: long('reply', 20_000) }));
		makeSummarizer().request(a);
		await settle();
		const { prompt } = calls[0]!;
		expect([...prompt].length).toBeLessThanOrEqual(8000);
		expect([...prompt].length).toBeGreaterThan(7900);
		for (const tag of ['m0', 'm4', 'reply']) {
			expect(prompt).toContain(`${tag}-start`);
			expect(prompt).toContain(`${tag}-end`);
		}
		expect(prompt).toContain('short question');
	});

	test('the cut never splits a character outside the basic plane', async () => {
		inputs.set(a, input({ userMessages: ['🚀'.repeat(9000)], reply: null }));
		makeSummarizer().request(a);
		await settle();
		expect(calls[0]!.prompt.isWellFormed()).toBe(true);
	});
});

describe('readApiKey', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'orfoni-key-'));
	});

	test('reads the key file without its trailing newline', async () => {
		writeFileSync(join(dir, 'key'), `${KEY}\n`, { mode: 0o600 });
		expect(await readApiKey(join(dir, 'key'), undefined)).toEqual({ key: KEY });
	});

	test('ANTHROPIC_API_KEY wins when set', async () => {
		writeFileSync(join(dir, 'key'), 'from-file', { mode: 0o600 });
		expect(await readApiKey(join(dir, 'key'), 'from-env')).toEqual({ key: 'from-env' });
	});

	test('a missing file without the variable means no key, and says how to add one', async () => {
		const key = await readApiKey(join(dir, 'key'), '');
		expect(key).toEqual({ missing: expect.stringContaining(join(dir, 'key')) });
	});

	test('a key file other accounts can read is refused with the fix', async () => {
		writeFileSync(join(dir, 'key'), KEY);
		chmodSync(join(dir, 'key'), 0o644);
		const key = await readApiKey(join(dir, 'key'), undefined);
		expect(key).toEqual({ missing: expect.stringContaining('chmod 600') });
		expect(JSON.stringify(key)).not.toContain(KEY);
	});
});

describe('claudeClient', () => {
	function message(fields: Record<string, unknown>) {
		return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_sequence: null, usage: { input_tokens: 812, output_tokens: 61 }, ...fields };
	}

	function api(body: object) {
		const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
		const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
			requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
		};
		return { requests, fetch };
	}

	test('asks for about and status as structured output at low effort, with the key and no sampling parameters', async () => {
		const { requests, fetch } = api(message({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"about":"Notes for orfoni","status":"Done."}' }] }));
		const result = await claudeClient(KEY, { fetch })({ model: 'claude-haiku-5-5', prompt: 'Session title: Notes' });
		expect(result).toEqual({ kind: 'summary', about: 'Notes for orfoni', status: 'Done.', usage: { inputTokens: 812, outputTokens: 61 } });
		const [request] = requests;
		expect([...(request?.headers.values() ?? [])].join('\n')).toContain(KEY);
		expect(request?.body).toMatchObject({
			model: 'claude-haiku-5-5',
			messages: [{ role: 'user', content: 'Session title: Notes' }],
			output_config: { effort: 'low', format: { type: 'json_schema', schema: { properties: { about: { type: 'string' }, status: { type: 'string' } }, required: ['about', 'status'] } } },
		});
		for (const field of ['temperature', 'top_p', 'top_k', 'thinking']) expect(request?.body).not.toHaveProperty(field);
	});

	test('a refusal comes back declined, without parsing the partial content', async () => {
		const { fetch } = api(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [{ type: 'text', text: '{"ab' }] }));
		const result = await claudeClient(KEY, { fetch })({ model: 'claude-haiku-5-5', prompt: 'x' });
		expect(result).toEqual({ kind: 'declined', reason: expect.stringContaining('cyber'), usage: { inputTokens: 812, outputTokens: 61 } });
	});

	test('a reply cut off at max_tokens comes back declined', async () => {
		const { fetch } = api(message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"about":"x' }] }));
		const result = await claudeClient(KEY, { fetch })({ model: 'claude-haiku-5-5', prompt: 'x' });
		expect(result).toMatchObject({ kind: 'declined', reason: expect.stringContaining('max_tokens') });
	});
});
