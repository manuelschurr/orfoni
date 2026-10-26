import type { ConnectionStatus, HubTransport, TerminalStream, TerminalTransport } from './transport';

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

function closeReason(event: CloseEvent, opened: boolean, url: string): string {
	if (!opened) return `could not connect to ${url}`;
	return `the connection closed${event.reason ? `: ${event.reason}` : ''} (code ${event.code})`;
}

export function wsHubTransport(url: string, backoffMs: number[] = BACKOFF_MS): HubTransport {
	const lineListeners: ((line: string) => void)[] = [];
	const statusListeners: ((status: ConnectionStatus) => void)[] = [];
	const emit = (status: ConnectionStatus) => {
		for (const listener of statusListeners) listener(status);
	};
	let socket: WebSocket | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let attempt = 0;
	let closed = false;

	function connect(): void {
		const ws = new WebSocket(url);
		let opened = false;
		let partial = '';
		socket = ws;
		ws.onopen = () => {
			opened = true;
			attempt = 0;
			emit({ kind: 'connected' });
		};
		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== 'string') return;
			const lines = (partial + event.data).split('\n');
			partial = lines.pop() ?? '';
			for (const line of lines) if (line !== '') for (const listener of lineListeners) listener(line);
		};
		ws.onclose = (event) => {
			socket = null;
			if (closed) return;
			attempt++;
			emit({ kind: 'reconnecting', attempt, error: closeReason(event, opened, url) });
			retry = setTimeout(connect, backoffMs[Math.min(attempt, backoffMs.length) - 1]);
		};
	}

	connect();
	return {
		send(line) {
			if (socket?.readyState === WebSocket.OPEN) socket.send(`${line}\n`);
		},
		onLine(listener) {
			lineListeners.push(listener);
		},
		onStatus(listener) {
			statusListeners.push(listener);
		},
		close() {
			closed = true;
			clearTimeout(retry);
			socket?.close();
		},
	};
}

export function wsTerminalTransport(base: string): TerminalTransport {
	return {
		open(target, cols, rows) {
			const url = `${base}/terminal?${new URLSearchParams({ target, cols: String(cols), rows: String(rows) })}`;
			const ws = new WebSocket(url);
			ws.binaryType = 'arraybuffer';
			const dataListeners: ((data: Uint8Array) => void)[] = [];
			const exitListeners: (() => void)[] = [];
			// tmux repaints the screen as soon as it attaches, which can arrive before the caller subscribes.
			let early: Uint8Array[] | null = [];
			ws.onmessage = (event: MessageEvent) => {
				if (!(event.data instanceof ArrayBuffer)) return;
				const data = new Uint8Array(event.data);
				if (early) early.push(data);
				else for (const listener of dataListeners) listener(data);
			};
			ws.addEventListener('close', () => {
				for (const listener of exitListeners) listener();
			});
			const stream: TerminalStream = {
				write(data) {
					if (ws.readyState === WebSocket.OPEN) ws.send(data);
				},
				resize(cols, rows) {
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: [cols, rows] }));
				},
				onData(listener) {
					dataListeners.push(listener);
					const queued = early ?? [];
					early = null;
					for (const data of queued) listener(data);
				},
				onExit(listener) {
					exitListeners.push(listener);
				},
				close() {
					ws.close();
				},
			};
			return new Promise((resolve, reject) => {
				ws.addEventListener('open', () => resolve(stream), { once: true });
				ws.addEventListener('close', (event) => reject(new Error(closeReason(event, false, url))), { once: true });
			});
		},
	};
}
