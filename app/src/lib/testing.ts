import { ClaudeSessionId, SessionId, type OtherSession, type SessionStateKind, type SessionSummary } from '@orfoni/protocol';
import { FakeTransport } from './fake-transport';
import { HubClient } from './hub-client.svelte';

export function otherSession(pid: number, changes: Partial<OtherSession> = {}): OtherSession {
	return {
		pid,
		claudeSessionId: ClaudeSessionId.parse('dc5b988b-a782-4352-9056-0c133ae7370a'),
		projectDir: '/root/projects/swarm',
		name: 'swarm-73',
		status: 'idle',
		statusSince: 1000,
		startedAt: 500,
		tmux: 'swarm',
		background: false,
		...changes,
	};
}

export function summary(id: string, state: SessionStateKind = 'idle', changes: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: SessionId.parse(id),
		projectDir: '/root/projects/alpha',
		title: null,
		claudeSessionId: ClaudeSessionId.parse('11111111-1111-4111-8111-111111111111'),
		state,
		stateSince: 1000,
		summary: null,
		tasks: null,
		memory: null,
		model: null,
		effort: null,
		...changes,
	};
}

export async function connectedClient(sessions: SessionSummary[], others: OtherSession[] = []): Promise<{ client: HubClient; transport: FakeTransport }> {
	const transport = new FakeTransport();
	const client = new HubClient(transport);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	transport.status({ kind: 'connected' });
	transport.respond('listSessions', sessions);
	await settle();
	transport.respond('listOtherSessions', others);
	await settle();
	return { client, transport };
}

// jsdom has no modal dialogs, and the dialogs open themselves with showModal.
export function stubDialogs(): void {
	HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	};
	Object.defineProperty(HTMLDialogElement.prototype, 'open', {
		configurable: true,
		get(this: HTMLDialogElement) {
			return this.hasAttribute('open');
		},
	});
}
