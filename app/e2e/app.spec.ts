import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Effort, HubStatus, OtherSession, PermissionMode, SessionSummary } from '@orfoni/protocol';
import { BRIDGE, Hub, newProjectDir, TOKEN } from './hub';
import { OutsideSession } from './outside';
import { onePagePdf } from '../../hub/test/e2e/client';
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

async function startReady(params: { prompt?: string; title?: string; effort?: Effort; permissionMode?: PermissionMode } = {}, dir = newProjectDir()): Promise<SessionSummary & { dir: string }> {
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

// The browser build hands a file it opens to the browser as a download.
async function download(page: Page, open: Locator): Promise<{ name: string; bytes: Buffer }> {
	const [file] = await Promise.all([page.waitForEvent('download'), open.click()]);
	return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

// Pictures of the views for a person to look over, kept with the run's other output.
async function snap(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(name) });
}

// Claude Code's own record of a session's task list, in the order it numbered the tasks.
function taskFiles(claudeSessionId: string): { subject: string; status: 'pending' | 'in_progress' | 'completed' }[] {
	const folder = join(homedir(), '.claude/tasks', claudeSessionId);
	return readdirSync(folder)
		.filter((name) => name.endsWith('.json') && !name.startsWith('.'))
		.map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')) as { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' })
		.sort((a, b) => Number(a.id) - Number(b.id));
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

test('the session list loads, and a session idle or ended for more than 48 hours shows once its folder opens the older ones', async ({ page }) => {
	await hub.start({ projectDir: newProjectDir(), title: 'list check' });
	const sessions = await hub.sessions();
	await page.goto(APP);
	// Sessions within ten minutes of 48 hours could fold while the check runs, so the check leaves them out until every folder is open.
	const hours = (session: SessionSummary) => (Date.now() - (session.lastActiveAt ?? session.stateSince)) / 3600_000;
	const quiet = sessions.filter((session) => session.state === 'idle' || session.state === 'offline');
	const older = quiet.filter((session) => hours(session) > 48.2);
	const recent = sessions.filter((session) => !quiet.includes(session) || hours(session) < 47.8);
	for (const session of recent) await expect(page.locator(`[data-session="${session.id}"]`)).toBeVisible();
	for (const session of older) await expect(page.locator(`[data-session="${session.id}"]`)).toHaveCount(0);
	const folds = page.locator('[data-fold]');
	await expect(folds.first()).toBeVisible({ visible: older.length > 0 });
	for (const fold of await folds.all()) {
		await expect(fold).toHaveText(/^\s*\d+ older sessions?(, \d+ still running)?$/);
		await fold.click();
		await expect(fold).toHaveAttribute('aria-expanded', 'true');
	}
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

test('a session opened from the list or the New session dialog takes typing at once, and on a touch screen it opens without the keyboard', async ({ page, browser }) => {
	const [first, second] = [await startReady(), await startReady()];
	const box = page.getByRole('textbox', { name: 'Message' });
	await openSession(page, first);
	await expect(box).toBeFocused();
	await page.locator(`[data-session="${second.id}"]`).click();
	await expect(box).toBeFocused();
	await page.keyboard.type('typed straight away');
	await expect(box).toHaveValue('typed straight away');

	await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
	const dialog = page.getByRole('dialog', { name: 'New session' });
	await dialog.getByLabel('Folder', { exact: true }).fill(newProjectDir());
	await dialog.getByRole('button', { name: 'Start session' }).click();
	await expect(dialog).toBeHidden();
	await expect(box).toBeFocused();

	const phone = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 915 } });
	try {
		const tapped = await phone.newPage();
		await tapped.goto(`http://127.0.0.1:5173${APP}`);
		expect(await tapped.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
		await tapped.locator(`[data-session="${first.id}"]`).tap();
		const phoneBox = tapped.getByRole('textbox', { name: 'Message' });
		await expect(phoneBox).toBeVisible();
		// Past the update that opened the session, where the focus would have come.
		await tapped.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))));
		await expect(phoneBox).not.toBeFocused();
	} finally {
		await phone.close();
	}
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

test('the memory screen opens from the status bar, lists a running session with its RAM and swap, and Stop there ends it', async ({ page }) => {
	const session = await startReady({ title: 'memory check' });
	await page.goto(APP);
	await page.getByRole('navigation').getByRole('button', { name: /free on the VPS$/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toBeVisible();
	await expect(page.getByText(/^RAM [\d.]+ (MB|GB) of [\d.]+ GB free$/)).toBeVisible();
	const row = page.getByRole('row', { name: /memory check/ });
	await expect(row.getByRole('cell').nth(1)).toContainText(/\d (MB|GB)$/);
	await expect(row.getByRole('cell').nth(0)).toContainText(/(ago|just now)$/);
	await row.getByRole('button', { name: 'Stop memory check' }).click();
	await expect(row).toHaveCount(0);
	await expect.poll(async () => (await hub.sessions()).find((s) => s.id === session.id)?.state).toBe('offline');
	await page.getByRole('button', { name: /^memory check/ }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toHaveCount(0);
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

test('rename a session from its header, and the list shows the new name', async ({ page }) => {
	const session = await startReady({ title: 'rename me' });
	await openSession(page, session);
	const main = page.getByRole('main');
	await main.getByRole('button', { name: 'Rename' }).click();
	const field = main.getByRole('textbox', { name: 'Session name' });
	await expect(field).toHaveValue('rename me');
	await field.fill('renamed in the header');
	await field.press('Enter');
	await expect(main.getByRole('heading', { level: 1 })).toHaveText('renamed in the header');
	await expect(page.getByRole('navigation', { name: 'Sessions' }).getByText('renamed in the header')).toBeVisible();
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
	const outside = OutsideSession.start(dir, 'Reply with only the result of 4096 divided by 2, in digits.');
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
		await box.fill('Add 1 to the number in your last reply. Reply with only the result, in digits.');
		await box.press('Enter');
		await expect(claude(page).last()).toContainText('2049', { timeout: REPLY_MS });
	} finally {
		outside.stop();
	}
});

test('a conversation that ended outside orfoni shows among the earlier conversations of its folder, the search finds it, and Continue opens it as an orfoni session that goes on with it', async ({ page }) => {
	const dir = newProjectDir();
	const outside = OutsideSession.start(dir, 'Reply with only the result of 1024 divided by 2, in digits.');
	let pid: number;
	try {
		await outside.acceptTrustPrompt();
		await outside.waitFor(() => outside.screen().includes('512'), 'replied', REPLY_MS);
		pid = (await hub.waitForOther((o) => o.projectDir === dir && o.status === 'idle', REPLY_MS)).pid;
	} finally {
		outside.stop();
	}
	await expect.poll(async () => ((await hub.request('listOtherSessions', {})) as OtherSession[]).some((o) => o.pid === pid), { timeout: 30_000 }).toBe(false);

	await page.goto(APP);
	await page.getByRole('button', { name: 'New session' }).first().click();
	const creating = page.getByRole('dialog', { name: 'New session' });
	await creating.getByLabel('Folder', { exact: true }).fill(dir);
	await creating.getByRole('button', { name: 'Continue an earlier conversation in this folder' }).click();
	const earlier = page.getByRole('dialog', { name: `Earlier conversations in ${basename(dir)}` });
	await expect(earlier.getByRole('listitem')).toHaveCount(1);
	const search = earlier.getByRole('searchbox', { name: 'Search' });
	await search.fill('kumquat');
	await expect(earlier.getByText('No conversation matches "kumquat".')).toBeVisible();
	await search.fill('Divided 1024');
	await earlier.getByRole('listitem').getByRole('button').click();

	const continuing = page.getByRole('dialog', { name: /^Continue ".*"$/ });
	await expect(continuing.getByLabel('Permissions')).toHaveValue('auto');
	await continuing.getByLabel('Model').selectOption('haiku');
	await continuing.getByRole('button', { name: 'Continue session' }).click();
	await expect(continuing).toBeHidden({ timeout: 30_000 });

	const box = page.getByRole('textbox', { name: 'Message' });
	await expect(box).toBeVisible();
	await expect(claude(page).first()).toContainText('512');
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
	await box.fill('Add 1 to the number in your last reply. Reply with only the result, in digits.');
	await box.press('Enter');
	await expect(claude(page).last()).toContainText('513', { timeout: REPLY_MS });

	await page.getByRole('button', { name: `Earlier conversations in ${basename(dir)}` }).click();
	await expect(page.getByRole('dialog', { name: `Earlier conversations in ${basename(dir)}` })).toContainText('No earlier conversations here.');
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

test('Claude\'s task list shows in the sidebar beside the conversation while it works and after, and the sidebar collapses to its count', async ({ page }) => {
	const session = await startReady({ title: 'task list check' });
	await openSession(page, session);
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill(
		'Use the TaskCreate tool three times to create the tasks alpha, beta, and gamma, in that order, each with an activeForm. Then use the TaskUpdate tool to mark alpha as in_progress. Then, without any tools, write a 1500-word story about a lighthouse keeper. Then use the TaskUpdate tool to mark alpha as completed and reply with exactly: tasks done',
	);
	await box.press('Enter');
	const sidebar = page.getByRole('complementary', { name: 'Task list' });
	const conversation = page.getByRole('region', { name: 'Conversation' });
	await expect(sidebar.getByRole('listitem')).toHaveText([/alpha/i, /beta/i, /gamma/i], { timeout: REPLY_MS });
	await expect(conversation.getByRole('status')).toBeVisible();
	await expect(conversation.getByRole('list', { name: 'Tasks' })).toHaveCount(0);

	await expect(claude(page).last()).toContainText('tasks done', { timeout: REPLY_MS });
	// haiku sometimes leaves out the last update, so the sidebar is held to what Claude Code recorded rather than to the prompt.
	const words = { pending: 'Pending', in_progress: 'In progress', completed: 'Done' };
	const recorded = taskFiles(session.claudeSessionId);
	expect(recorded.map((task) => task.subject.toLowerCase())).toEqual(['alpha', 'beta', 'gamma']);
	await expect(sidebar.getByRole('listitem')).toHaveText(recorded.map((task) => new RegExp(`^\\s*${words[task.status]}:\\s.*${task.subject}`, 'i')));
	const done = recorded.filter((task) => task.status === 'completed').length;
	await sidebar.getByRole('button', { name: 'Hide the task list' }).click();
	await expect(sidebar.getByRole('listitem')).toHaveCount(0);
	await expect(sidebar.getByRole('button', { name: `Show the task list, ${done} of 3 done` })).toHaveText(`${done}/3`);
	await sidebar.getByRole('button', { name: /^Show the task list/ }).click();
	await expect(sidebar.getByRole('listitem')).toHaveCount(3);
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

test('switch the permission mode from the header and see the session restart in it, with the user settings unchanged', async ({ page }) => {
	const before = userDefaults();
	const session = await startReady({ title: 'mode check', prompt: 'Reply with exactly: ok' });
	await openSession(page, session);
	const main = page.getByRole('main');
	await expect(claude(page).last()).toContainText(/ok/i, { timeout: REPLY_MS });
	const mode = main.getByRole('combobox', { name: 'Permissions' });
	await expect(mode).toHaveValue('default', { timeout: 60_000 });
	await mode.selectOption('plan');
	await expect(mode).toHaveValue('plan', { timeout: 60_000 });
	await expect(mode.locator('option:checked')).toHaveText('Plan');
	await expect(main.getByRole('alert')).toHaveCount(0);
	await hub.waitForSession(session.id, (s) => s.permissionMode === 'plan' && s.state === 'idle', undefined, 60_000);
	expect(userDefaults()).toEqual(before);
});

test('the header shows how full the context is once Claude has answered, and the status bar shows the plan windows', async ({ page }) => {
	const session = await startReady({ title: 'context check', prompt: 'Reply with exactly: ok' });
	await openSession(page, session);
	await expect(claude(page).last()).toContainText(/ok/i, { timeout: REPLY_MS });
	await expect(page.getByRole('main').getByRole('meter', { name: 'Context' })).toHaveAttribute('aria-valuetext', /^\d+% of the context window used$/, { timeout: 60_000 });
	// The status bar asks the hub every 30 s, and at once when the page loads.
	await page.reload();
	await expect(page.getByText(/^5-hour limit \d+% used, resets /)).toBeVisible({ timeout: 60_000 });
});

// The session starts in Manual mode, where Read asks first for a file outside the session's folder, as the uploads are.
test('a PDF picked with the paperclip goes to Claude with the message, and the chat shows it by its name', async ({ page }) => {
	const session = await startReady({ title: 'pdf check' });
	await openSession(page, session);
	await page.getByLabel('Attach images or PDFs').setInputFiles({ name: 'code word.pdf', mimeType: 'application/pdf', buffer: onePagePdf('The code word is OSPREY.') });
	await expect(page.getByTitle('code word.pdf', { exact: true })).toBeVisible();
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('What is the code word in this PDF? Reply with just the code word.');
	await box.press('Enter');
	await expect(you(page).last()).toHaveText('code_word.pdf What is the code word in this PDF? Reply with just the code word.', { timeout: 60_000 });
	await expect(claude(page).last()).toContainText(/OSPREY/i, { timeout: REPLY_MS });
	await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0);
	await expect(page.getByRole('main').getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
});

test('a background subagent\'s report folds into a quiet line named after its task, not into a message from you, and opens to show the report', async ({ page }) => {
	const prompt = 'Use the Agent tool with run_in_background set to true, subagent_type general-purpose, description "Say pong", and prompt "Reply with exactly: pong. Use no tools." Then reply with exactly: started, and stop.';
	const session = await startReady({ title: 'subagent check', prompt, permissionMode: 'auto' });
	await openSession(page, session);
	const line = page.getByRole('button', { name: 'Report from the agent: Say pong' });
	await expect(line).toBeVisible({ timeout: REPLY_MS });
	await expect(line).toHaveAttribute('aria-expanded', 'false');
	// Claude answers once when it starts the subagent and again once it has read the report.
	await expect(claude(page)).toHaveCount(2, { timeout: REPLY_MS });
	await expect(you(page)).toHaveText([prompt]);
	await line.click();
	await expect(page.getByRole('main').getByText(/^pong\.?$/i)).toBeVisible();
});

test('an image pasted into the message box goes to Claude with the message', async ({ page }) => {
	const session = await startReady({ title: 'image check' });
	await openSession(page, session);
	const box = page.getByRole('textbox', { name: 'Message' });
	// A screenshot reaches the page as a PNG file on the clipboard.
	await box.evaluate(async (element) => {
		const canvas = document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 64;
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'rgb(0, 200, 0)';
		context.fillRect(0, 0, 64, 64);
		const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), 'image/png'));
		const clipboard = new DataTransfer();
		clipboard.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
		element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
	});
	await expect(page.getByRole('img', { name: 'screenshot.png' })).toBeVisible();
	await box.fill('What colour is this image? Reply with one word.');
	await box.press('Enter');
	await expect(you(page).last()).toContainText(/\[Image #\d+\] What colour is this image\?/, { timeout: 60_000 });
	await expect(claude(page).last()).toContainText(/green/i, { timeout: REPLY_MS });
	await expect(page.getByRole('img', { name: 'screenshot.png' })).toHaveCount(0);
});

// The start time is twelve hours off, so the hub has no exchange of its own while the check runs.
test('Plan limits takes a start time for the 5-hour window, shows the next start, and turns it off again', async ({ page }) => {
	const before = ((await hub.request('hubStatus', {})) as HubStatus).automation;
	if (!before) throw new Error('the hub reports nothing about the plan limits');
	const later = new Date(Date.now() + 12 * 3600_000);
	const startWindowAt = later.getHours() * 60 + later.getMinutes();
	const clock = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
	const settings = async () => ((await hub.request('hubStatus', {})) as HubStatus).automation?.settings;
	const dialog = page.getByRole('dialog', { name: 'Plan limits' });
	const start = dialog.getByRole('checkbox', { name: 'Start the 5-hour window early' });
	try {
		await hub.request('setPlanSettings', { startWindowAt: null, continueAfterLimit: true });
		await page.goto(APP);
		await page.getByRole('button', { name: 'Plan limits' }).click();
		await expect(start).not.toBeChecked();
		await expect(dialog.getByRole('checkbox', { name: 'Continue sessions after a limit' })).toBeChecked();
		await start.check();
		await dialog.getByLabel('Start time').fill(clock);
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(dialog).toBeHidden();
		expect(await settings()).toEqual({ startWindowAt, continueAfterLimit: true });

		await page.getByRole('button', { name: 'Plan limits' }).click();
		await expect(dialog.getByLabel('Start time')).toHaveValue(clock);
		await expect(dialog.getByText('Next start')).toBeVisible();
		await expect(dialog.getByText(`whose time zone is ${before.timeZone}`)).toBeVisible();
		await start.uncheck();
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(dialog).toBeHidden();
		expect(await settings()).toEqual({ startWindowAt: null, continueAfterLimit: true });
	} finally {
		await hub.request('setPlanSettings', before.settings);
	}
});

// A turn at a plan limit cannot be had on demand, so the check hands the hub the hook and the transcript Claude Code hands it then, with a reset three hours off.
test('a session at a plan limit reads Limit reached, and says when the limit resets and when orfoni sends continue in its header and in its row', async ({ page }) => {
	const before = ((await hub.request('hubStatus', {})) as HubStatus).automation;
	if (!before) throw new Error('the hub reports nothing about the plan limits');
	const session = await startReady({ prompt: 'Reply with exactly: ready', title: 'At the limit' });
	// Claude Code reports its start after the hub has listed the session, and a start takes a limit away.
	await hub.waitForSession(session.id, (current) => current.state === 'answered', undefined, REPLY_MS);
	const resetsAt = (Math.floor(Date.now() / 1000) + 3 * 3600) * 1000;
	const clock = (time: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time);
	const transcript = join(mkdtempSync(join(tmpdir(), 'orfoni-limit-')), `${session.claudeSessionId}.jsonl`);
	writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, quotaLimits: { status: 'rejected', resetsAt: resetsAt / 1000, rateLimitType: 'five_hour' } })}\n`);
	const failed = { hook_event_name: 'StopFailure', session_id: session.claudeSessionId, error: 'rate_limit', last_assistant_message: `You've hit your 5-hour limit · resets ${clock(resetsAt)}`, transcript_path: transcript };
	const socket = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, 'orfoni', 'hooks.sock');
	try {
		await hub.request('setPlanSettings', { continueAfterLimit: true });
		execFileSync('curl', ['-sS', '-m', '5', '--unix-socket', socket, '--data-binary', '@-', '-H', 'Content-Type: application/json', '-H', `X-Orfoni-Session: ${session.id}`, 'http://localhost/hook'], { input: JSON.stringify(failed) });
		await openSession(page, session);
		await expect(shownState(page, 'Limit reached')).toBeVisible();
		await expect(page.getByRole('main').getByText(`The limit resets at ${clock(resetsAt)}. orfoni sends continue at ${clock(resetsAt + 60_000)}.`, { exact: true })).toBeVisible();
		await expect(page.locator(`[data-session="${session.id}"]`)).toContainText(`continues ${clock(resetsAt + 60_000)}`);

		await hub.request('setPlanSettings', { continueAfterLimit: false });
		await expect(page.getByRole('main').getByText(`The limit resets at ${clock(resetsAt)}.`, { exact: true })).toBeVisible();
		await expect(page.locator(`[data-session="${session.id}"]`)).not.toContainText('continues');
	} finally {
		await hub.request('setPlanSettings', before.settings);
	}
});

// Claude Code offers SendUserFile only while Remote Control is connected, so this folder turns it on, and the session lists on claude.ai while it runs.
test('the files Claude sends show as one card with the caption and a thumbnail, and one opens as a download after it is gone from the folder', async ({ page }) => {
	const tag = randomUUID().slice(0, 8);
	const dir = newProjectDir();
	writeFileSync(`${dir}/.claude/settings.local.json`, '{ "remoteControlAtStartup": true }\n');
	const png = fileURLToPath(new URL('../src-tauri/icons/128x128.png', import.meta.url));
	copyFileSync(png, join(dir, 'icon.png'));
	const session = await startReady(
		{
			permissionMode: 'auto',
			prompt: `Use the Write tool to create note.txt containing exactly: kept-${tag}. Then call the SendUserFile tool once, with files set to ["note.txt", "icon.png"], caption set to "Your note and the icon", and display set to "render". Then reply with exactly: sent-${tag}`,
		},
		dir,
	);
	await openSession(page, session);
	const card = page.locator('[data-kind="sent"]').getByRole('article', { name: 'Claude sent you 2 files' });
	await expect(card).toBeVisible({ timeout: REPLY_MS });
	await expect(claude(page).last()).toContainText(`sent-${tag}`, { timeout: REPLY_MS });
	await expect(card.getByText('Your note and the icon', { exact: true })).toBeVisible();
	const original = readFileSync(join(dir, 'note.txt'));
	expect(original.toString('utf8')).toContain(`kept-${tag}`);
	const note = card.getByRole('button', { name: 'Open note.txt' });
	await expect(note).toContainText(`${original.length} bytes`);
	await expect(card.getByRole('button', { name: 'Open icon.png' })).toContainText(`${Math.round(statSync(png).size / 1024)} KB`);
	const thumbnail = card.getByRole('img', { name: 'icon.png' });
	await expect(thumbnail).toBeVisible();
	expect(await thumbnail.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([128, 128]);

	rmSync(join(dir, 'note.txt'));
	expect(await download(page, note)).toEqual({ name: 'note.txt', bytes: original });
	await expect(card.getByText('Downloaded note.txt.', { exact: true })).toBeVisible();
	await card.scrollIntoViewIfNeeded();
	await snap(page, 'desktop-card.png');

	await page.setViewportSize({ width: 412, height: 915 });
	await card.scrollIntoViewIfNeeded();
	const box = await card.boundingBox();
	expect(box?.x).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(412);
	expect(await page.evaluate(() => document.scrollingElement?.scrollWidth)).toBe(412);
	await snap(page, 'phone-card.png');
});

test('the Files button opens the session folder beside the chat, a file there downloads, a folder opens and its path leads back, and the files close again', async ({ page }) => {
	const dir = newProjectDir();
	const readme = Buffer.from(`files check ${randomUUID()}\n`);
	writeFileSync(join(dir, 'readme.txt'), readme);
	mkdirSync(join(dir, 'docs'));
	writeFileSync(join(dir, 'docs', 'inner.txt'), 'inside\n');
	const session = await startReady({ title: 'files check' }, dir);
	await openSession(page, session);
	const button = page.getByRole('main').getByRole('button', { name: 'Files', exact: true });
	await expect(button).toHaveAttribute('aria-pressed', 'false');
	await button.click();
	await expect(button).toHaveAttribute('aria-pressed', 'true');
	const panel = page.getByRole('complementary', { name: 'Files' });
	await expect(panel.getByRole('heading', { name: `Files in ${basename(dir)}` })).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Open the folder .claude' })).toBeVisible();
	const file = panel.getByRole('button', { name: 'Open readme.txt' });
	await expect(file).toContainText(`${readme.length} bytes`);
	expect(await download(page, file)).toEqual({ name: 'readme.txt', bytes: readme });
	await expect(panel.getByText('Downloaded readme.txt.', { exact: true })).toBeVisible();
	await snap(page, 'desktop-files.png');

	await panel.getByRole('button', { name: 'Open the folder docs' }).click();
	const path = panel.getByRole('navigation', { name: 'Folder path' });
	await expect(path.getByRole('button', { name: 'docs', exact: true })).toHaveAttribute('aria-current', 'location');
	await expect(panel.getByRole('button', { name: 'Open inner.txt' })).toBeVisible();
	await expect(file).toHaveCount(0);
	await path.getByRole('button', { name: basename(dir), exact: true }).click();
	await expect(file).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Open inner.txt' })).toHaveCount(0);

	await panel.getByRole('button', { name: 'Close the files' }).click();
	await expect(panel).toHaveCount(0);
	await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('on a phone, Files under More opens the session folder as a sheet over the chat, and going back closes it', async ({ browser }) => {
	const dir = newProjectDir();
	writeFileSync(join(dir, 'readme.txt'), 'on the phone\n');
	const session = await startReady({ title: 'phone files check' }, dir);
	const phone = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 915 } });
	try {
		const page = await phone.newPage();
		await page.goto(`http://127.0.0.1:5173${APP}`);
		await page.locator(`[data-session="${session.id}"]`).tap();
		const main = page.getByRole('main');
		await main.getByRole('button', { name: 'More' }).tap();
		await main.getByRole('button', { name: 'Files', exact: true }).tap();
		const sheet = page.getByRole('dialog', { name: `Files in ${basename(dir)}` });
		await expect(sheet.getByRole('button', { name: 'Open readme.txt' })).toBeVisible();
		const box = await sheet.boundingBox();
		expect(box?.x).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(412);
		await snap(page, 'phone-files.png');
		await page.goBack();
		await expect(sheet).toHaveCount(0);
		await expect(main.getByRole('heading', { level: 1 })).toHaveText('phone files check');
	} finally {
		await phone.close();
	}
});
