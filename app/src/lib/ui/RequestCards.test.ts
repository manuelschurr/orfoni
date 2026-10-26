import { RequestId } from '@orfoni/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import { connectedClient, summary } from '../testing';
import ApprovalCard from './ApprovalCard.svelte';
import PlanCard from './PlanCard.svelte';
import QuestionCard from './QuestionCard.svelte';

const requestId = RequestId.parse('r1');
const question = { question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };

test('a pending approval offers Allow, Always allow, and Deny, and Allow answers the hub', async () => {
	const { client, transport } = await connectedClient([summary('a1', 'needs_approval')]);
	render(ApprovalCard, { client, item: { kind: 'approval', requestId, toolName: 'Write', input: { file_path: '/root/a.txt' }, status: 'pending' } });
	expect(screen.getAllByRole('button', { name: /^(Allow|Always allow|Deny)$/ }).map((b) => b.textContent?.trim())).toEqual(['Allow', 'Always allow', 'Deny']);
	await fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
	expect(transport.requests('decide')).toMatchObject([{ requestId: 'r1', decision: { type: 'allow' } }]);
});

test('a pending question answers the hub with the option you pick', async () => {
	const { client, transport } = await connectedClient([summary('a1', 'needs_answer')]);
	render(QuestionCard, { client, item: { kind: 'question', requestId, questions: [question], status: 'pending' } });
	await fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
	expect(transport.requests('decide')).toMatchObject([{ requestId: 'r1', decision: { type: 'answer', answers: { 'Which color do you prefer?': 'Blue' } } }]);
});

test('cards that are no longer pending show their outcome and no buttons', async () => {
	const { client } = await connectedClient([summary('a1')]);
	const approval = render(ApprovalCard, { client, item: { kind: 'approval', requestId, toolName: 'Write', input: { file_path: '/root/a.txt' }, status: 'allowed' } });
	expect(screen.getByText('Allowed')).toBeTruthy();
	expect(screen.queryAllByRole('button', { name: /Allow|Deny/ })).toEqual([]);
	approval.unmount();

	const answered = render(QuestionCard, { client, item: { kind: 'question', requestId, questions: [question], status: 'answered', answers: { 'Which color do you prefer?': 'Blue' } } });
	expect(screen.getByText('Answered')).toBeTruthy();
	expect(screen.getByText('Blue')).toBeTruthy();
	expect(screen.queryAllByRole('button')).toEqual([]);
	answered.unmount();

	render(PlanCard, { client, item: { kind: 'plan', requestId, plan: '1. Write c.txt', status: 'withdrawn' } });
	expect(screen.getByText('Withdrawn')).toBeTruthy();
	expect(screen.queryAllByRole('button', { name: /Approve|Reject/ })).toEqual([]);
});
