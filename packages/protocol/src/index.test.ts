import { describe, expect, test } from 'vitest';
import { parseClientRequest, parseHubMessage, ProtocolError, type HubMessage } from './index.js';

function expectBadMessage(line: string) {
	try {
		parseClientRequest(line);
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe('bad_message');
		return;
	}
	throw new Error(`expected ${line} to be rejected`);
}

describe('parseClientRequest', () => {
	test('accepts a send request and returns it typed', () => {
		const request = parseClientRequest('{"id":1,"method":"send","sessionId":"s","text":"hi"}');
		expect(request).toEqual({ id: 1, method: 'send', sessionId: 's', text: 'hi' });
	});

	test('rejects text that is not JSON', () => {
		expectBadMessage('not json');
	});

	test('rejects an unknown method', () => {
		expectBadMessage('{"id":1,"method":"selfDestruct"}');
	});

	test('rejects send without text', () => {
		expectBadMessage('{"id":1,"method":"send","sessionId":"s"}');
	});
});

describe('parseHubMessage', () => {
	test('round-trips a chat item carrying an approval', () => {
		const message: HubMessage = {
			type: 'chatItem',
			sessionId: 's',
			item: { kind: 'approval', requestId: 'r1', toolName: 'Write', input: { file_path: 'a.txt', content: 'hi' }, status: 'pending' },
		};
		expect(parseHubMessage(JSON.stringify(message))).toEqual(message);
	});
});
