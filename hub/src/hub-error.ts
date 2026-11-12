import type { ErrorCode } from '@orfoni/protocol';

// What a request fails with, which the hub answers with its code and message.
export class HubError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'HubError';
	}
}
