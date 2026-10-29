import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Effort, HubStatus, PermissionMode, SessionSummary } from '@orfoni/protocol';
import { BRIDGE, Hub, newProjectDir, TOKEN } from './hub';
import { OutsideSession } from './outside';
import { acceptTrustPrompt, Screen, sleep } from './terminal';

const REPLY_MS = 120_000;
const APP = `/?${new URLSearchParams({ transport: 'ws', token: TOKEN })}`;
let hub: Hub;

test.beforeEach(async () => {
	hub = await Hub.connect();
});

test.afterEach(async () => {
	await hub.removeOurs();
	hub.close();
});

async function startReady(params: { prompt?: string; title?: string; effort?: Effort; permissionMode?: PermissionMode } = {}): Promise<SessionSummary & { dir: string }> {
	const dir = newProjectDir();
	const { session, needsTrust } = await hub.start({ projectDir: dir, ...params });
	if (needsTrust) await acceptTrustPrompt(session.id);
	return { ...session, dir };
}

async function openSession(page: Page, session: SessionSummary, url = APP): Promise<void> {
	await page.goto(url);
	await page.locator(`[data-session="${session.id}"]`).click();
}

function you(page: Page) {
	return page.getByRole('article', { name: 'You' });
}

function claude(page: Page) {
	return page.getByRole('article', { name: 'Claude' });
}

function shownState(page: Page, label: string) {
	return page.getByRole('main').getByText(label, { exact: true });
}

// What /model and /effort typed into Claude Code would change for every new session, which no check may touch.
function userDefaults() {
	const { model, effortLevel, modelSettings, fastMode } = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8')) as Record<string, unknown>;
	return { model, effortLevel, modelSettings, fastMode };
}

test('the bridge refuses connections that lack its token', async () => {
	const refused = (url: string) =>
		new Promise<boolean>((resolve) => {
			const socket = new WebSocket(url);
			socket.onopen = () => {
				socket.close();
				resolve(false);
			};
			socket.onerror = () => resolve(true);
		});
	expect(await refused(`${BRIDGE}/hub`)).toBe(true);
	expect(await refused(`${BRIDGE}/hub?token=wrong`)).toBe(true);
	expect(await refused(`${BRIDGE}/terminal?${new URLSearchParams({ target: '=orfoni-0', cols: '80', rows: '24' })}`)).toBe(true);
});

test('the session list loads', async ({ page }) => {
	await hub.start({ projectDir: newProjectDir(), title: 'list check' });
	const sessions = await hub.sessions();
	await page.goto(APP);
	for (const session of sessions) await expect(page.locator(`[data-session="${session.id}"]`)).toBeVisible();
});

test('start a session and see the reply as a bubble', async ({ page }) => {
	await page.goto(APP);
	await expect(page.getByRole('status').getByText('Connected', { exact: true })).toBeVisible();
	await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
	const dialog = page.getByRole('dialog', { name: 'New session' });
	await dialog.getByLabel('Folder', { exact: true }).fill(newProjectDir());
	await dialog.getByLabel('First message').fill('Reply with exactly: pong 7d3');
	await dialog.getByLabel('Model').selectOption('haiku');
	await dialog.getByRole('button', { name: 'Start session' }).click();
	await expect(dialog).toBeHidden();

	await expect(page.getByText('Claude Code asks whether you trust this folder')).toBeVisible();
	const sessionId = (await page.locator('[data-session][aria-current="true"]').getAttribute('data-session')) ?? '';
	await page.getByRole('button', { name: 'Open terminal' }).click();
	await expect(page.getByRole('tab', { selected: true })).toBeVisible();
	await acceptTrustPrompt(sessionId);

	await expect(you(page)).toHaveText('Reply with exactly: pong 7d3', { timeout: REPLY_MS });
	await expect(claude(page)).toContainText('pong 7d3', { timeout: REPLY_MS });
	await expect(page.locator('[data-session][aria-current="true"]')).toContainText('Reply with exactly: pong 7d3');
});

test('allow an approval from its card', async ({ page }) => {
	const session = await startReady({ prompt: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done' });
	await openSession(page, session);
	const card = page.getByRole('article', { name: 'Approval for Write' });
	await card.getByRole('button', { name: 'Allow', exact: true }).click({ timeout: REPLY_MS });
	await expect(card.getByText('Allowed')).toBeVisible();
	await expect(card.getByRole('button')).toHaveCount(0);
	await expect(claude(page).last()).toContainText('done', { timeout: REPLY_MS });
	expect(readFileSync(`${session.dir}/a.txt`, 'utf8').trim()).toBe('hi');
});

test('answer a question from its card', async ({ page }) => {
	const session = await startReady({
		prompt: 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with exactly: chosen <color>',
	});
	await openSession(page, session);
	const card = page.getByRole('article', { name: 'Question from Claude' });
	await card.getByRole('button', { name: 'Blue' }).click({ timeout: REPLY_MS });
	await expect(card.getByText('Answered')).toBeVisible();
	await expect(claude(page).last()).toContainText(/blue/i, { timeout: REPLY_MS });
});

test('approve a plan from its card', async ({ page }) => {
	const session = await startReady({
		permissionMode: 'plan',
		prompt: 'Plan how to create a file c.txt containing the word planned. Keep the plan to two short steps and present it with ExitPlanMode right away. Do not ask questions.',
	});
	await openSession(page, session);
	const card = page.getByRole('article', { name: 'Plan from Claude' });
	await expect(card).toContainText('c.txt', { timeout: REPLY_MS });
	await card.getByRole('button', { name: 'Approve plan' }).click();
	await expect(card.getByText('Approved')).toBeVisible();
	const next = page
		.getByRole('article', { name: /^Approval for / })
		.filter({ hasText: 'c.txt' })
		.or(page.getByRole('button', { name: /c\.txt|Wrote a file/ }));
	await expect(next.first()).toBeVisible({ timeout: REPLY_MS });
});

test('a message waiting on an approval keeps its text', async ({ page }) => {
	const session = await startReady({ prompt: 'Use the Write tool to create a.txt containing hi. Then reply with exactly: done' });
	await openSession(page, session);
	await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible({ timeout: REPLY_MS });
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('please also add a test');
	await box.press('Enter');
	await expect(page.getByText(/waits for an answer/)).toBeVisible();
	await expect(box).toHaveValue('please also add a test');
	await expect(you(page)).toHaveCount(1);
});

test('interrupt a running turn', async ({ page }) => {
	const session = await startReady({ prompt: 'Write a 3000 word essay about the history of terminals, in plain prose. No tools.' });
	await openSession(page, session);
	const interrupt = page.getByRole('button', { name: 'Interrupt' });
	await expect(interrupt).toBeVisible({ timeout: REPLY_MS });
	await sleep(2000);
	await interrupt.click();
	await expect(shownState(page, 'Idle')).toBeVisible();
	await expect(interrupt).toBeHidden();
	await sleep(3000);
	await expect(shownState(page, 'Idle')).toBeVisible();
});

test('a prompt typed in the terminal shows up in the chat', async ({ page }) => {
	const session = await startReady({ title: 'two views' });
	const screen = await Screen.attach(`=orfoni-${session.id}`);
	try {
		await screen.waitFor('❯', 60_000);
		await sleep(2500);
		await openSession(page, session);
		await page.getByRole('button', { name: 'Terminal', exact: true }).click();
		await page.getByRole('tabpanel').locator('.xterm').click();
		await page.keyboard.type('Reply with exactly: typed in the terminal 51');
		await page.keyboard.press('Enter');
		await expect(you(page)).toHaveText('Reply with exactly: typed in the terminal 51', { timeout: REPLY_MS });
		await expect(claude(page).last()).toContainText('typed in the terminal 51', { timeout: REPLY_MS });

		const box = page.getByRole('textbox', { name: 'Message' });
		await box.fill('Reply with exactly: sent from the chat 52');
		await box.press('Enter');
		await expect(box).toHaveValue('');
		await screen.waitFor('sent from the chat 52', 30_000);
		await expect(claude(page).last()).toContainText('sent from the chat 52', { timeout: REPLY_MS });
	} finally {
		screen.close();
	}
});

test('task progress and memory show on the row, in the header, and in the status bar', async ({ page }) => {
	const session = await startReady({
		prompt: 'Use the TaskCreate tool to create two tasks, one named alpha and one named beta. Then use the TaskUpdate tool to mark alpha as completed. Do not work on beta. Then reply with exactly: tasks set',
	});
	await openSession(page, session);
	await expect(claude(page).last()).toContainText('tasks set', { timeout: REPLY_MS });
	await expect(page.locator(`[data-session="${session.id}"]`)).toContainText('1/2');
	await expect(page.getByRole('main').getByRole('progressbar', { name: 'Tasks' })).toHaveAttribute('aria-valuetext', '1 of 2 tasks done');
	await expect(page.getByRole('main').getByText(/^[\d.]+ (MB|GB)( of [\d.]+ GB)?$/)).toBeVisible();
	await expect(page.getByRole('navigation').getByText(/^[\d.]+ (MB|GB) of [\d.]+ GB free on the VPS$/)).toBeVisible();
});

test('a summary shows on the row and in the header when the hub has an API key', async ({ page }) => {
	const status = (await hub.request('hubStatus', {})) as HubStatus;
	test.skip(!status.summaries.enabled, 'the hub has no API key, so it writes no summaries');
	const session = await startReady({ prompt: 'Reply with exactly: summary check 3' });
	const { summary } = await hub.waitForSession(session.id, (s) => s.summary !== null, 0, REPLY_MS);
	if (!summary) throw new Error('unreachable');
	await page.goto(APP);
	await expect(page.getByRole('navigation').getByText(/^Summaries on, \$\d+\.\d\d today$/)).toBeVisible();
	const row = page.locator(`[data-session="${session.id}"]`);
	await expect(row).toContainText(summary.about);
	await row.click();
	await expect(page.getByRole('main').getByText(summary.status, { exact: true })).toBeVisible();
});

// /model and /effort typed into Claude Code also change the defaults of every new session, so the header restarts this one session and leaves the user's settings alone.
test('change the effort from the header and see the level Claude Code reports there, with the user settings unchanged', async ({ page }) => {
	const before = userDefaults();
	const session = await startReady({ title: 'effort check', effort: 'low', prompt: 'Reply with exactly: ok' });
	await openSession(page, session);
	const main = page.getByRole('main');
	await expect(claude(page).last()).toContainText(/ok/i, { timeout: REPLY_MS });
	const effort = main.getByRole('combobox', { name: 'Effort' });
	await expect(effort).toHaveValue('low', { timeout: 60_000 });
	await expect(main.getByRole('combobox', { name: 'Model' }).locator('option:checked')).toHaveText(/Haiku/);
	await effort.selectOption('high');
	await expect(effort).toHaveValue('high', { timeout: 60_000 });
	await expect(effort.locator('option:checked')).toHaveText('High');
	await expect(main.getByRole('status')).toHaveCount(0);
	await expect(main.getByRole('alert')).toHaveCount(0);
	expect((await hub.sessions()).find((s) => s.id === session.id)?.effort).toBe('high');
	expect(userDefaults()).toEqual(before);
});

test('Fork starts a second session on its own first message from the conversation so far, next to the first, and each goes its own way', async ({ page }) => {
	const before = userDefaults();
	const session = await startReady({ title: 'fork check', prompt: 'Remember the code word papaya. Reply with exactly: ok' });
	// A fork goes on the model the original reports, so the check waits for it rather than start the fork on the default.
	await hub.waitForSession(session.id, (s) => s.state === 'answered' && s.model !== null, undefined, REPLY_MS);
	await openSession(page, session);
	const main = page.getByRole('main');
	await main.getByRole('button', { name: 'Fork' }).click();
	const dialog = page.getByRole('dialog', { name: 'Fork "fork check"' });
	await dialog.getByRole('textbox', { name: 'First message of the fork' }).fill('What is the code word? Reply with just the word.');
	await dialog.getByRole('button', { name: 'Fork' }).click();
	await expect(main.getByRole('heading', { level: 1 })).toHaveText('What is the code word? Reply with just the word. ⑂');
	await expect(you(page).first()).toContainText('Remember the code word papaya');
	await expect(claude(page).last()).toContainText('papaya', { timeout: REPLY_MS });
	await expect(page.getByRole('navigation', { name: 'Sessions' }).getByText('What is the code word? Reply with just the word. ⑂')).toBeVisible();
	await page.locator(`[data-session="${session.id}"]`).click();
	await expect(main.getByRole('heading', { level: 1 })).toHaveText('fork check');
	await expect(you(page)).toHaveCount(1);
	expect(userDefaults()).toEqual(before);
});

test('remove a session', async ({ page }) => {
	const { session } = await hub.start({ projectDir: newProjectDir(), title: 'remove me' });
	await openSession(page, session);
	await page.getByRole('main').getByRole('button', { name: 'Remove' }).click();
	const confirm = page.getByRole('dialog', { name: 'Remove "remove me"?' });
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: 'Remove session' }).click();
	await expect(page.locator(`[data-session="${session.id}"]`)).toHaveCount(0);
	await expect(page.getByText('Pick a session on the left, or start a new one.')).toBeVisible();
	expect((await hub.sessions()).map((s) => s.id)).not.toContain(session.id);
});

test('reconnect after the bridge restarts without duplicated items', async ({ page }) => {
	const port = '4791';
	const bridgePath = fileURLToPath(new URL('../../tools/dev-bridge/bridge.mjs', import.meta.url));
	const startBridge = async (): Promise<ChildProcess> => {
		const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ORFONI_BRIDGE_PORT: port }, stdio: 'ignore' });
		for (let i = 0; i < 50; i++) {
			if (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false)) return child;
			await sleep(100);
		}
		throw new Error('the second bridge did not start');
	};
	let bridge = await startBridge();
	try {
		const session = await startReady({ prompt: 'Reply with exactly: one' });
		await openSession(page, session, `${APP}&bridge=ws://127.0.0.1:${port}`);
		await expect(claude(page)).toContainText(/one/i, { timeout: REPLY_MS });
		await expect(you(page)).toHaveCount(1);
		await expect(claude(page)).toHaveCount(1);

		const exited = new Promise((resolve) => bridge.once('exit', resolve));
		bridge.kill('SIGTERM');
		await exited;
		await expect(page.getByRole('status').getByText(/^Reconnecting/)).toBeVisible();
		bridge = await startBridge();
		await expect(page.getByRole('status').getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
		await sleep(1000);
		await expect(you(page)).toHaveCount(1);
		await expect(claude(page)).toHaveCount(1);

		const box = page.getByRole('textbox', { name: 'Message' });
		await box.fill('Reply with exactly: two');
		await box.press('Enter');
		await expect(claude(page).last()).toContainText(/two/i, { timeout: REPLY_MS });
		await expect(you(page)).toHaveCount(2);
		await expect(claude(page)).toHaveCount(2);
	} finally {
		bridge.kill('SIGTERM');
	}
});

test('a session outside orfoni shows under its folder and ports into an orfoni session that goes on with its conversation', async ({ page }) => {
	const dir = newProjectDir();
	const outside = OutsideSession.start(dir, 'Remember the code word kumquat. Reply with only the result of 4096 divided by 2, in digits.');
	try {
		await outside.acceptTrustPrompt();
		await outside.waitFor(() => outside.screen().includes('2048'), 'replied', REPLY_MS);
		const claudeCommand = outside.command();
		const other = await hub.waitForOther((o) => o.projectDir === dir && o.status === 'idle', REPLY_MS);

		await page.goto(APP);
		await page.getByRole('list', { name: `${basename(dir)}, outside orfoni` }).locator(`[data-other="${other.pid}"]`).click();
		const main = page.getByRole('main');
		await expect(main.getByText(dir, { exact: true })).toBeVisible();
		await expect(main.getByText('Outside orfoni', { exact: true })).toBeVisible();
		await expect(claude(page).last()).toContainText('2048');
		await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);

		await main.getByRole('button', { name: 'Port into orfoni' }).click();
		const dialog = page.getByRole('dialog', { name: /^Port ".*" into orfoni\?$/ });
		await expect(dialog.getByLabel('Permissions')).toHaveValue('auto');
		await dialog.getByRole('button', { name: 'Port session' }).click();
		await expect(dialog).toBeHidden({ timeout: 30_000 });

		const box = page.getByRole('textbox', { name: 'Message' });
		await expect(box).toBeVisible();
		await expect(claude(page).first()).toContainText('2048');
		await expect(page.locator(`[data-other="${other.pid}"]`)).toHaveCount(0);
		await outside.waitFor(() => outside.command() !== claudeCommand, 'returned to its shell', 30_000);

		const sessionId = (await page.locator('[data-session][aria-current="true"]').getAttribute('data-session')) ?? '';
		expect((await hub.sessions()).find((s) => s.id === sessionId)?.projectDir).toBe(dir);
		const screen = await Screen.attach(`=orfoni-${sessionId}`);
		try {
			await screen.waitFor('❯', 60_000);
			expect(screen.text()).not.toContain('Yes, I trust this folder');
			await sleep(2500);
		} finally {
			screen.close();
		}
		await box.fill('What was the code word? Reply with only that word.');
		await box.press('Enter');
		await expect(claude(page).last()).toContainText(/kumquat/i, { timeout: REPLY_MS });
	} finally {
		outside.stop();
	}
});

// Screen reader text is positioned absolutely, so a pane that scrolls without being its containing block lets that text stretch the page down to the pane's full content.
test('the app scrolls inside its panes and never as a whole page', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 640 });
	const session = await startReady({ prompt: 'Reply with a numbered markdown list of the numbers 1 to 40, one item per number, and nothing else.' });
	await openSession(page, session);
	await expect.poll(() => claude(page).last().locator('li').count(), { timeout: REPLY_MS }).toBeGreaterThanOrEqual(30);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Use the Bash tool to run: echo done. Then reply with exactly: listed');
	await box.press('Enter');
	await expect(claude(page).last()).toContainText(/listed/i, { timeout: REPLY_MS });
	await page.getByRole('main').getByRole('button', { name: /^Ran a command/ }).click();
	await expect(page.getByRole('main').getByRole('button', { name: /echo done/ })).toBeVisible();
	await claude(page).first().hover();
	await page.mouse.wheel(0, -20_000);
	await expect(page.getByRole('main').getByRole('button', { name: /echo done/ })).not.toBeInViewport();
	expect(await page.evaluate(() => document.scrollingElement?.scrollHeight)).toBe(await page.evaluate(() => innerHeight));
});

test('while Claude works the conversation shows a timer and what it is doing, and that goes away once the reply is in', async ({ page }) => {
	const session = await startReady({ title: 'working check' });
	await openSession(page, session);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Write a 600-word story about a terminal that learns to dream. No tools.');
	await box.press('Enter');
	const main = page.getByRole('main');
	// The app's own word, or the line Claude Code shows, such as "Writing the story…", once the hub reads it.
	const working = main.getByRole('status').filter({ hasText: /^(Thinking|Writing|.+…)$/ });
	await expect(working).toBeVisible({ timeout: 15_000 });
	await expect(main.getByText(/^\d+s$/)).toBeVisible();
	await expect(working).toHaveCount(0, { timeout: REPLY_MS });
	await expect(claude(page).last()).toContainText(/\w{3}/);
});

test('while Claude works its task list shows under the conversation, and once the turn is over the header opens it', async ({ page }) => {
	const session = await startReady({ title: 'task list check' });
	await openSession(page, session);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill(
		'Use the TaskCreate tool three times to create the tasks alpha, beta, and gamma, in that order, each with an activeForm. Then use the TaskUpdate tool to mark alpha as in_progress. Then, without any tools, write a 1500-word story about a lighthouse keeper. Then use the TaskUpdate tool to mark alpha as completed and reply with exactly: tasks done',
	);
	await box.press('Enter');
	const conversation = page.getByRole('region', { name: 'Conversation' });
	await expect(conversation.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveText([/alpha/i, /beta/i, /gamma/i], { timeout: REPLY_MS });
	await expect(conversation.getByRole('status')).toBeVisible();

	await expect(claude(page).last()).toContainText('tasks done', { timeout: REPLY_MS });
	await expect(conversation.getByRole('list', { name: 'Tasks' })).toHaveCount(0);
	const main = page.getByRole('main');
	await main.getByRole('button', { name: 'Task list', exact: true }).click();
	await expect(main.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveText([/^\s*Done:\s.*alpha/i, /^\s*Pending:\s.*beta/i, /^\s*Pending:\s.*gamma/i]);
});

test('typing /cl suggests /clear from the commands of the folder, and Tab completes it, with the user settings unchanged', async ({ page }) => {
	const before = userDefaults();
	const session = await startReady({ title: 'commands check' });
	await openSession(page, session);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.click();
	await box.pressSequentially('/cl');
	const commands = page.getByRole('listbox', { name: 'Commands' });
	await expect(commands.getByRole('option', { selected: true })).toHaveAccessibleName(/^\/clear /, { timeout: 30_000 });
	await box.press('Tab');
	await expect(box).toHaveValue('/clear ');
	await expect(box).toBeFocused();
	await expect(commands).toHaveCount(0);
	await box.fill('');
	expect(userDefaults()).toEqual(before);
});
