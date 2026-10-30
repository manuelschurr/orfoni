// Claude Code tells Claude about a finished background task, a subagent or a monitor's event in a message of its own wrapped in <task-notification>, which reaches the prompt hook and the transcript the way a message you typed does. The notice keeps what it says happened and leaves out what it tells Claude alone.
export function taskNotice(text: string): string | null {
	const block = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/.exec(text)?.[1];
	if (block === undefined) return null;
	const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim();
	const summary = field('summary') ?? 'A background task reported back';
	const event = field('event');
	return event ? `${summary}: ${event}` : summary;
}
