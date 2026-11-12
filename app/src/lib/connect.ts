import { isTauri } from '@tauri-apps/api/core';
import { browserDeviceFiles, tauriDeviceFiles, type DeviceFiles } from './device-files';
import { TauriHubTransport, TauriTerminalTransport } from './tauri-transport';
import type { HubTransport, TerminalTransport } from './transport';
import { wsHubTransport, wsTerminalTransport } from './ws-transport';

export type Transports = { kind: 'bridge'; hub: HubTransport; terminal: TerminalTransport; files: DeviceFiles } | { kind: 'tauri'; hub: TauriHubTransport; terminal: TerminalTransport; files: DeviceFiles };

export function createTransports(): Transports {
	// Anything that reloads the app can choose its query, so the installed app never takes its hub from the address.
	if (isTauri()) return { kind: 'tauri', hub: new TauriHubTransport(), terminal: new TauriTerminalTransport(), files: tauriDeviceFiles };
	const query = new URLSearchParams(window.location.search);
	if (query.get('transport') === 'ws') {
		const bridge = query.get('bridge') ?? 'ws://127.0.0.1:4790';
		const token = query.get('token') ?? '';
		return { kind: 'bridge', hub: wsHubTransport(`${bridge}/hub?${new URLSearchParams({ token })}`), terminal: wsTerminalTransport(bridge, token), files: browserDeviceFiles };
	}
	throw new Error('This page runs inside the orfoni app. Open it with ?transport=ws to use the development bridge.');
}
