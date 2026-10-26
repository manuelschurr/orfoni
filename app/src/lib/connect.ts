import { isTauri } from '@tauri-apps/api/core';
import { TauriHubTransport, TauriTerminalTransport } from './tauri-transport';
import type { HubTransport, TerminalTransport } from './transport';
import { wsHubTransport, wsTerminalTransport } from './ws-transport';

export type Transports = { kind: 'bridge'; hub: HubTransport; terminal: TerminalTransport } | { kind: 'tauri'; hub: TauriHubTransport; terminal: TerminalTransport };

export function createTransports(): Transports {
	// Anything that reloads the app can choose its query, so the installed app never takes its hub from the address.
	if (isTauri()) return { kind: 'tauri', hub: new TauriHubTransport(), terminal: new TauriTerminalTransport() };
	const query = new URLSearchParams(window.location.search);
	if (query.get('transport') === 'ws') {
		const bridge = query.get('bridge') ?? 'ws://127.0.0.1:4790';
		return { kind: 'bridge', hub: wsHubTransport(`${bridge}/hub`), terminal: wsTerminalTransport(bridge) };
	}
	throw new Error('This page runs inside the orfoni app. Open it with ?transport=ws to use the development bridge.');
}
