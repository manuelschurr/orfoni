import type { HubTransport, TerminalTransport } from './transport';
import { wsHubTransport, wsTerminalTransport } from './ws-transport';

export async function createTransports(): Promise<{ hub: HubTransport; terminal: TerminalTransport }> {
	const query = new URLSearchParams(window.location.search);
	if (query.get('transport') === 'ws') {
		const bridge = query.get('bridge') ?? 'ws://127.0.0.1:4790';
		return { hub: wsHubTransport(`${bridge}/hub`), terminal: wsTerminalTransport(bridge) };
	}
	throw new Error('The Tauri transport is not wired yet. Open the app with ?transport=ws to use the development bridge.');
}
