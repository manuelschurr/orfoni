import type { ChatItem, SessionSummary } from '@orfoni/protocol';

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

export function formatSession(session: SessionSummary): string {
	return [session.id, session.state, session.projectDir, session.title ?? ''].join('\t');
}
