// Claude Code 2.1.314 lists a permission dialog's options under its question, with a pointer at the one in focus, such as " ❯ 1. Yes". A dialog that a single stray keystroke must not answer opens on " ❯ No" instead, without digit shortcuts, and Claude Code ignores a hook's allow for some of those, such as deleting an artifact. The input box's own pointer starts its line.
const FOCUSED = /^ +❯ (\d+\. )?(.+)$/u;

// Undefined while the screen shows no dialog.
export function dialogOpensOnNo(screen: string): boolean | undefined {
	for (const line of screen.split('\n').reverse()) {
		const match = FOCUSED.exec(line.trimEnd());
		if (match) return match[1] === undefined && match[2] === 'No';
	}
	return undefined;
}
