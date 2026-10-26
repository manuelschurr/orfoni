import type { ConnectOutcome, Settings } from './tauri-transport';

export interface SetupPort {
	loadSettings(): Promise<Settings>;
	saveSettings(settings: Settings): Promise<void>;
	connect(passphrase?: string): Promise<ConnectOutcome>;
	trustHost(fingerprint: string): Promise<void>;
}

export type HostKeyQuestion = { kind: 'hostKeyUnknown'; address: string; fingerprint: string } | { kind: 'hostKeyChanged'; address: string; expected: string; found: string; knownHostsFile: string };

export type SetupStep =
	| { kind: 'connecting' }
	| { kind: 'settings'; settings: Settings; cancellable: boolean; error: string | null }
	| HostKeyQuestion
	| { kind: 'passphrase'; rejected: boolean }
	| { kind: 'failed'; error: string }
	| { kind: 'connected' };

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Setup {
	step = $state<SetupStep>({ kind: 'connecting' });
	// Kept in memory only, so that trusting the host or saving settings for the same key does not ask again.
	#passphrase: string | undefined;

	constructor(private readonly port: SetupPort) {}

	async start(): Promise<void> {
		this.step = { kind: 'connecting' };
		let settings: Settings;
		try {
			settings = await this.port.loadSettings();
		} catch (error) {
			this.step = { kind: 'failed', error: `Reading the settings failed: ${reason(error)}` };
			return;
		}
		if (settings.host === '') {
			this.step = { kind: 'settings', settings, cancellable: false, error: null };
			return;
		}
		let outcome: ConnectOutcome;
		try {
			outcome = await this.port.connect(this.#passphrase);
		} catch (error) {
			this.step = { kind: 'failed', error: reason(error) };
			return;
		}
		this.step = this.#next(outcome, `${settings.host}:${settings.port}`);
	}

	#next(outcome: ConnectOutcome, address: string): SetupStep {
		switch (outcome.kind) {
			case 'connected':
			case 'failed':
				return outcome;
			case 'hostKeyUnknown':
			case 'hostKeyChanged':
				return { ...outcome, address };
			case 'passphraseNeeded': {
				const rejected = this.#passphrase !== undefined;
				this.#passphrase = undefined;
				return { kind: 'passphrase', rejected };
			}
		}
	}

	async unlock(passphrase: string): Promise<void> {
		this.#passphrase = passphrase;
		await this.start();
	}

	async trust(): Promise<void> {
		if (this.step.kind !== 'hostKeyUnknown') return;
		const { fingerprint } = this.step;
		this.step = { kind: 'connecting' };
		try {
			await this.port.trustHost(fingerprint);
		} catch (error) {
			this.step = { kind: 'failed', error: `Trusting the host key failed: ${reason(error)}` };
			return;
		}
		await this.start();
	}

	async edit(): Promise<void> {
		const cancellable = this.step.kind === 'connected';
		try {
			this.step = { kind: 'settings', settings: await this.port.loadSettings(), cancellable, error: null };
		} catch (error) {
			this.step = { kind: 'failed', error: `Reading the settings failed: ${reason(error)}` };
		}
	}

	cancelEdit(): void {
		if (this.step.kind === 'settings' && this.step.cancellable) this.step = { kind: 'connected' };
	}

	async save(settings: Settings): Promise<void> {
		if (this.step.kind !== 'settings') return;
		const { cancellable, settings: before } = this.step;
		this.step = { kind: 'connecting' };
		try {
			await this.port.saveSettings(settings);
		} catch (error) {
			this.step = { kind: 'settings', settings, cancellable, error: `Saving the settings failed: ${reason(error)}` };
			return;
		}
		if (settings.keyPath !== before.keyPath) this.#passphrase = undefined;
		await this.start();
	}
}
