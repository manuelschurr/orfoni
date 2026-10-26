import { ClaudeSessionId, SessionId, type SessionStateKind, type SessionSummary } from '@orfoni/protocol';
import { FakeTransport } from './fake-transport';
import { HubClient } from './hub-client.svelte';

export function summary(id: string, state: SessionStateKind = 'idle', changes: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: SessionId.parse(id),
		projectDir: '/root/projects/alpha',
		title: null,
		claudeSessionId: ClaudeSessionId.parse('11111111-1111-4111-8111-111111111111'),
		state,
		stateSince: 1000,
		...changes,
	};
}

export async function connectedClient(sessions: SessionSummary[]): Promise<{ client: HubClient; transport: FakeTransport }> {
	const transport = new FakeTransport();
	const client = new HubClient(transport);
	transport.status({ kind: 'connected' });
	transport.respond('listSessions', sessions);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { client, transport };
}
