import { Channel, invoke } from '@tauri-apps/api/core';
import type { ConnectionStatus, HubTransport, TerminalStream, TerminalTransport } from './transport';

export interface Settings {
	host: string;
	port: number;
	user: string;
	keyPath: string;
	hubCommand: string;
}

export type ConnectOutcome =
	| { kind: 'connected' }
	| { kind: 'failed'; error: string }
	| { kind: 'hostKeyUnknown'; fingerprint: string }
	| { kind: 'hostKeyChanged'; expected: string; found: string; knownHostsFile: string }
	| { kind: 'passphraseNeeded' };

type LinkEvent = { kind: 'line'; value: string } | { kind: 'status'; value: ConnectionStatus };

export function loadSettings(): Promise<Settings> {
	return invoke('settings_get');
}

export function saveSettings(settings: Settings): Promise<void> {
	return invoke('settings_set', { settings });
}

export class TauriHubTransport implements HubTransport {
	#lineListeners: ((line: string) => void)[] = [];
	#statusListeners: ((status: ConnectionStatus) => void)[] = [];
	#events: Channel<LinkEvent> | null = null;

	connect(passphrase?: string): Promise<ConnectOutcome> {
		// A link that Rust replaced can still deliver a late event, which must not overwrite what the new link reports.
		const events: Channel<LinkEvent> = new Channel<LinkEvent>((event) => {
			if (events !== this.#events) return;
			if (event.kind === 'line') for (const listener of this.#lineListeners) listener(event.value);
			else for (const listener of this.#statusListeners) listener(event.value);
		});
		this.#events = events;
		return invoke('connect', { passphrase, events });
	}

	trustHost(fingerprint: string): Promise<void> {
		return invoke('trust_host', { fingerprint });
	}

	send(line: string): Promise<void> {
		return invoke('hub_send', { line });
	}

	onLine(listener: (line: string) => void): void {
		this.#lineListeners.push(listener);
	}

	onStatus(listener: (status: ConnectionStatus) => void): void {
		this.#statusListeners.push(listener);
	}

	close(): void {
		this.#events = null;
		void invoke('disconnect');
	}
}

export class TauriTerminalTransport implements TerminalTransport {
	async open(target: string, cols: number, rows: number): Promise<TerminalStream> {
		const stream = new TauriTerminalStream();
		stream.id = await invoke<number>('terminal_open', { target, cols, rows, onData: stream.channel });
		return stream;
	}
}

class TauriTerminalStream implements TerminalStream {
	id = 0;
	readonly channel = new Channel<ArrayBuffer | null>((message) => this.#receive(message));
	#dataListeners: ((data: Uint8Array) => void)[] = [];
	#exitListeners: (() => void)[] = [];
	#early: Uint8Array[] = [];
	#exited = false;
	#unsent: Uint8Array[] = [];
	#writing = false;

	write(data: Uint8Array): void {
		this.#unsent.push(data);
		if (!this.#writing) void this.#flush();
	}

	// One write at a time, because separate IPC requests are not guaranteed to arrive in order.
	async #flush(): Promise<void> {
		this.#writing = true;
		while (this.#unsent.length > 0) {
			const data = concat(this.#unsent.splice(0));
			try {
				await invoke('terminal_write', data, { headers: { 'terminal-id': String(this.id) } });
			} catch (error) {
				console.warn('terminal_write', error);
			}
		}
		this.#writing = false;
	}

	resize(cols: number, rows: number): void {
		void invoke('terminal_resize', { id: this.id, cols, rows });
	}

	onData(listener: (data: Uint8Array) => void): void {
		this.#dataListeners.push(listener);
		for (const chunk of this.#early.splice(0)) listener(chunk);
	}

	onExit(listener: () => void): void {
		this.#exitListeners.push(listener);
		if (this.#exited) listener();
	}

	close(): void {
		void invoke('terminal_close', { id: this.id });
	}

	#receive(message: ArrayBuffer | null): void {
		if (message === null) {
			this.#exited = true;
			for (const listener of this.#exitListeners) listener();
			return;
		}
		const chunk = new Uint8Array(message);
		if (this.#dataListeners.length === 0) this.#early.push(chunk);
		else for (const listener of this.#dataListeners) listener(chunk);
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}
