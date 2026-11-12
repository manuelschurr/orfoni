import type { ErrorCode } from '@orfoni/protocol';

export class HubError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'HubError';
	}
}
