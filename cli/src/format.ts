import type { ChatItem, HubStatus, SessionSummary } from '@orfoni/protocol';

function outcome(status: string): string {
	return status === 'pending' ? '' : ` (${status})`;
}

export function formatChatItem(item: ChatItem): string {
	switch (item.kind) {
		case 'user':
			return `you: ${item.text}`;
		case 'assistant':
			return `claude: ${item.text}`;
		case 'notice':
			return `notice: ${item.text}`;
		case 'peer':
			return item.from.kind === 'subagent' ? `subagent ${item.from.agentId}: ${item.text}` : `session ${item.from.name ?? 'without a name'}: ${item.text}`;
		case 'tool':
			return `tool ${item.name} (${item.status}): ${JSON.stringify(item.input)}`;
		case 'approval': {
			const head = `approval ${item.requestId}: ${item.toolName}${outcome(item.status)}`;
			return item.status === 'pending' ? `${head}\n${JSON.stringify(item.input)}` : head;
		}
		case 'question': {
			const lines = [`question ${item.requestId}${outcome(item.status)}:`];
			for (const { question, options } of item.questions) {
				const answer = item.answers?.[question];
				if (answer !== undefined) lines.push(`${question} ${answer}`);
				else lines.push(question, ...options.map((option, i) => `  ${i + 1}. ${option.label}`));
			}
			return lines.join('\n');
		}
		case 'plan':
			return `plan ${item.requestId}${outcome(item.status)}:\n${item.plan}`;
	}
}

function timeOfDay(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// The plan's limits and what the hub does about them, with every time in the hub's time zone, since the command may run on another machine.
export function formatPlan({ plan, automation }: Pick<HubStatus, 'plan' | 'automation'>, now: number): string {
	if (automation === null) return 'This hub does nothing about the plan limits yet. Update it with hub/scripts/install.sh.';
	const { settings, timeZone, nextWindowStartAt, lastWindowStart: last } = automation;
	const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
	const window = (name: string, limit: NonNullable<HubStatus['plan']>['fiveHour'] | undefined) => (limit && limit.resetsAt > now ? [`${name}: ${Math.round(limit.usedPercent)}% used, resets ${stamp.format(limit.resetsAt)}`] : []);
	const lines = [...window('5-hour limit', plan?.fiveHour), ...window('weekly limit', plan?.sevenDay)];
	lines.push(settings.startWindowAt === null ? 'start-window: off' : `start-window: ${timeOfDay(settings.startWindowAt)} ${timeZone}${nextWindowStartAt === null ? '' : `, next start ${stamp.format(nextWindowStartAt)}`}`);
	if (last) {
		const found = last.resetsAt === null ? null : last.started ? `started a window that resets ${stamp.format(last.resetsAt)}` : `a window was running until ${stamp.format(last.resetsAt)}`;
		lines.push(`last start: ${stamp.format(last.at)}, ${[found, last.problem && `failed: ${last.problem}`].filter(Boolean).join(', ')}`);
	}
	lines.push(`continue: ${settings.continueAfterLimit ? 'on' : 'off'}`);
	return lines.join('\n');
}

export function formatSession(session: SessionSummary): string {
	return [session.id, session.state, session.projectDir, session.title ?? ''].join('\t');
}
