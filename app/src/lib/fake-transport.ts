import { parseClientRequest, type ClientRequest, type ErrorCode, type HubMessage } from '@orfoni/protocol';
import type { ConnectionStatus, HubTransport } from './transport';

type Method = ClientRequest['method'];

export class FakeTransport implements HubTransport {
	readonly sent: ClientRequest[] = [];
	closed = false;
	private sendError: string | null = null;
	private readonly answered = new Set<number>();
	private readonly lineListeners: ((line: string) => void)[] = [];
	private readonly statusListeners: ((status: ConnectionStatus) => void)[] = [];

	send(line: string): Promise<void> {
		if (this.sendError !== null) return Promise.reject(this.sendError);
		this.sent.push(parseClientRequest(line));
		return Promise.resolve();
	}

	failSends(error: string | null): void {
		this.sendError = error;
	}

	onLine(listener: (line: string) => void): void {
		this.lineListeners.push(listener);
	}

	onStatus(listener: (status: ConnectionStatus) => void): void {
		this.statusListeners.push(listener);
	}

	close(): void {
		this.closed = true;
	}

	status(status: ConnectionStatus): void {
		for (const listener of this.statusListeners) listener(status);
	}

	push(message: HubMessage): void {
		this.line(JSON.stringify(message));
	}

	line(line: string): void {
		for (const listener of this.lineListeners) listener(line);
	}

	requests<M extends Method>(method: M): Extract<ClientRequest, { method: M }>[] {
		return this.sent.filter((request): request is Extract<ClientRequest, { method: M }> => request.method === method);
	}

	unanswered<M extends Method>(method: M): Extract<ClientRequest, { method: M }> {
		const request = this.requests(method).find(({ id }) => !this.answered.has(id));
		if (!request) throw new Error(`no unanswered ${method} request`);
		return request;
	}

	respond(method: Method, result: unknown): void {
		const { id } = this.unanswered(method);
		this.answered.add(id);
		this.push({ type: 'response', id, ok: true, result });
	}

	fail(method: Method, code: ErrorCode, message: string): void {
		const { id } = this.unanswered(method);
		this.answered.add(id);
		this.push({ type: 'response', id, ok: false, error: { code, message } });
	}
}
