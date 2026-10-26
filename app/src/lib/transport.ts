export type ConnectionStatus =
	| { kind: 'connecting' }
	| { kind: 'connected' }
	| { kind: 'reconnecting'; attempt: number; error: string }
	| { kind: 'failed'; error: string };

export interface HubTransport {
	send(line: string): void;
	onLine(listener: (line: string) => void): void;
	onStatus(listener: (status: ConnectionStatus) => void): void;
	close(): void;
}

export interface TerminalStream {
	write(data: Uint8Array): void;
	resize(cols: number, rows: number): void;
	onData(listener: (data: Uint8Array) => void): void;
	onExit(listener: () => void): void;
	close(): void;
}

export interface TerminalTransport {
	open(target: string, cols: number, rows: number): Promise<TerminalStream>;
}
