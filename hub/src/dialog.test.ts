import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { dialogOpensOnNo } from './dialog.js';

// Screens of claude --model haiku in a 200 by 50 tmux pane, captured with tmux capture-pane -p from Claude Code 2.1.314 right after the PermissionRequest hook reached the hub, and from 2.1.312 while it works.
function screen(name: string): string {
	return readFileSync(new URL(`../test/fixtures/screens/${name}.txt`, import.meta.url), 'utf8');
}

test('a dialog that opens on No without digit shortcuts, as deleting an artifact does, opens on No', () => {
	expect(dialogOpensOnNo(screen('dialog-opens-on-no'))).toBe(true);
});

test('a dialog that opens on 1. Yes, as creating a file does, does not', () => {
	expect(dialogOpensOnNo(screen('dialog-opens-on-yes'))).toBe(false);
});

test('a numbered No in focus is an ordinary dialog whose focus moved, not one that opened on No', () => {
	expect(dialogOpensOnNo(' Do you want to proceed?\n   1. Yes\n ❯ 2. No\n')).toBe(false);
});

test('a screen without a dialog, whose only pointers are your message and the input box, shows none', () => {
	expect(dialogOpensOnNo(screen('working-on-a-task'))).toBeUndefined();
	expect(dialogOpensOnNo('')).toBeUndefined();
});
