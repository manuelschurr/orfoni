import type { DocumentType, ImageType, SessionId } from '@orfoni/protocol';
import { SvelteMap } from 'svelte/reactivity';

export type Attachment = { kind: 'image'; type: ImageType } | { kind: 'document'; type: DocumentType };
export type Attached = Attachment & {
	name: string;
	// Read once, for the thumbnail and for sending.
	dataUrl: string;
};

export interface Draft {
	text: string;
	attachments: Attached[];
}

const PREFIX = 'orfoni.draft.';

// What each session's message box holds until it is sent or deleted, which the box shows and changes, so it is still there when the session opens again. The text stays in storage across restarts. Attachments can come to 150 MB, far past what storage holds, so they stay only while the app runs.
export class Drafts {
	private readonly texts = new SvelteMap<SessionId, string>();
	private readonly attachments = new SvelteMap<SessionId, Attached[]>();

	get(sessionId: SessionId): Draft {
		return { text: this.texts.get(sessionId) ?? stored(sessionId), attachments: this.attachments.get(sessionId) ?? [] };
	}

	setText(sessionId: SessionId, text: string): void {
		this.texts.set(sessionId, text);
		try {
			if (text === '') localStorage.removeItem(PREFIX + sessionId);
			else localStorage.setItem(PREFIX + sessionId, text);
		} catch {
			// The text then lasts until the app closes.
		}
	}

	// Replaced as a whole, never changed in place, so a sent message can tell whether its attachments are still the ones in the box.
	setAttachments(sessionId: SessionId, attachments: Attached[]): void {
		if (attachments.length === 0) this.attachments.delete(sessionId);
		else this.attachments.set(sessionId, attachments);
	}

	// What was typed or attached while the message was on its way stays.
	sent(sessionId: SessionId, { text, attachments }: Draft): void {
		const draft = this.get(sessionId);
		if (draft.text === text) this.setText(sessionId, '');
		if (draft.attachments === attachments) this.setAttachments(sessionId, []);
	}

	forget(sessionId: SessionId): void {
		this.setText(sessionId, '');
		this.setAttachments(sessionId, []);
	}
}

// Storage the app cannot use keeps no text.
function stored(sessionId: SessionId): string {
	try {
		return localStorage.getItem(PREFIX + sessionId) ?? '';
	} catch {
		return '';
	}
}
