const HOOK_TIMEOUTS = {
	SessionStart: 5,
	SessionEnd: 5,
	UserPromptSubmit: 5,
	MessageDisplay: 2,
	PreToolUse: 5,
	PostToolUse: 5,
	PostToolUseFailure: 5,
	PermissionRequest: 3600,
	TaskCreated: 5,
	TaskCompleted: 5,
	Stop: 5,
	StopFailure: 5,
} as const;

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function hookSettings(socket: string): object {
	const hooks = Object.fromEntries(
		Object.entries(HOOK_TIMEOUTS).map(([hook, timeout]) => [
			hook,
			[
				{
					hooks: [
						{
							type: 'command',
							command: `curl -sS -m ${timeout} --unix-socket ${shellQuote(socket)} --data-binary @- -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" http://localhost/hook 2>/dev/null || true`,
							timeout,
						},
					],
				},
			],
		]),
	);
	return { hooks };
}
