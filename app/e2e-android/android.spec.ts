import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { _android, expect, test, type AndroidDevice, type Page } from '@playwright/test';
import type { SessionId } from '@orfoni/protocol';
import { acceptTrustPrompt, eventually, HubClient, newProjectDir, pane, tmux, type Started } from '../../hub/test/e2e/client';

const PACKAGE = 'com.orfoni.app.debug';
const SERVER = '/var/tmp/claude-0/orfoni-android-sshd';
const REPLY_MS = 120_000;

let device: AndroidDevice;
let hub: HubClient;
const started: SessionId[] = [];

function adb(...args: string[]): string {
	return execFileSync('adb', args, { encoding: 'utf8', env: { ...process.env, PATH: `/opt/android-sdk/platform-tools:${process.env.PATH}` } });
}

// A fresh start of the app, with no settings, no trusted host and no key, as on the first day. OnePlus phones refuse pm clear over adb, and run-as reaches only a debug build's own files.
async function freshApp(): Promise<Page> {
	adb('shell', 'am', 'force-stop', PACKAGE);
	adb('shell', `run-as ${PACKAGE} rm -rf settings.json known-hosts.json ssh shared_prefs/orfoni.xml`);
	return appPage();
}

// Starts the app or brings it to the front, and connects to the WebView of the process running now, since the socket of one that was just stopped can linger.
async function appPage(): Promise<Page> {
	adb('shell', 'am', 'start', '-W', '-n', `${PACKAGE}/com.orfoni.app.MainActivity`);
	const socketName = await eventually(
		async () => {
			const pid = adb('shell', `pidof ${PACKAGE} || true`).trim();
			return pid !== '' && adb('shell', `grep -a webview_devtools_remote_${pid} /proc/net/unix || true`).includes(pid) ? `webview_devtools_remote_${pid}` : null;
		},
		(name) => name !== null,
		30_000,
	);
	const webview = await device.webView({ socketName: socketName! }, { timeout: 30_000 });
	return webview.page();
}

test.beforeAll(async () => {
	execFileSync(new URL('../../tools/android/test-server.sh', import.meta.url).pathname, { stdio: 'ignore' });
	const devices = await _android.devices();
	const chosen = devices.find((candidate) => !process.env.ANDROID_SERIAL || candidate.serial() === process.env.ANDROID_SERIAL);
	if (!chosen) throw new Error('no phone is connected to adb');
	device = chosen;
	hub = HubClient.connect();
});

test.afterAll(async () => {
	for (const sessionId of started.splice(0)) await hub.request('removeSession', { sessionId }).catch(() => {});
	hub.close();
	await device.close();
});

// From a fresh start: make a key on the phone, authorize it on the throwaway sshd, log in, and trust the host key, checked against the server's.
async function logIn(page: Page): Promise<string> {
	const settings = page.getByRole('dialog', { name: 'Connect to the VPS' });
	await settings.getByRole('button', { name: 'Make a key on this phone' }).click();
	const publicKey = await settings.getByLabel('Public key').inputValue();
	expect(publicKey).toMatch(/^ssh-ed25519 \S+ orfoni-android$/);
	appendFileSync(`${SERVER}/authorized_keys`, `${publicKey}\n`);
	await settings.getByLabel('Host').fill('127.0.0.1');
	await settings.getByLabel('Port').fill('2422');
	await settings.getByLabel('User').fill('root');
	await settings.getByRole('button', { name: 'Save and connect' }).click();
	const hostKey = execFileSync('ssh-keygen', ['-lf', `${SERVER}/host_key.pub`, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1]!;
	const trust = page.getByRole('dialog', { name: 'Trust this host?' });
	await expect(trust).toContainText(hostKey);
	await trust.getByRole('button', { name: 'Trust and connect' }).click();
	await expect(page.getByRole('navigation', { name: 'Sessions' })).toBeVisible();
	// The first connection asks once to be let off battery limits, in a dialog of Android's that pauses the page until it is answered.
	expect(await declineBatteryExemption()).toBe(true);
	return publicKey;
}

// The page fits the phone's width, unzoomed, without scrolling sideways.
async function expectNoSidewaysScroll(page: Page): Promise<void> {
	const fit = await page.evaluate(() => ({ width: innerWidth, scroll: document.scrollingElement!.scrollWidth, scale: visualViewport?.scale ?? 1 }));
	expect(fit).toEqual({ width: 384, scroll: 384, scale: 1 });
}

// The phone's own screenshot, since one taken through the WebView can come out tiled. It stays in the git-ignored test results.
async function phoneScreenshot(name: string): Promise<void> {
	writeFileSync(test.info().outputPath(name), execFileSync('adb', ['exec-out', 'screencap', '-p'], { env: { ...process.env, PATH: `/opt/android-sdk/platform-tools:${process.env.PATH}` }, maxBuffer: 64 * 1024 * 1024 }));
}

async function startSession(title: string, prompt: string): Promise<SessionId> {
	const result = (await hub.request('startSession', { projectDir: newProjectDir(), model: 'haiku', permissionMode: 'default', title, prompt })) as Started;
	started.push(result.session.id);
	await acceptTrustPrompt(result);
	return result.session.id;
}

test('on the phone, orfoni makes its own key, logs in with it, and gets Claude to answer a message sent from the phone', async () => {
	const tag = randomUUID().slice(0, 8);
	const page = await freshApp();
	const publicKey = await logIn(page);

	await startSession(`phone ${tag}`, `Reply with exactly: first-${tag}`);
	await page.getByRole('navigation', { name: 'Sessions' }).getByText(`phone ${tag}`).click();
	await expect(page.getByRole('article', { name: 'Claude' }).last()).toContainText(`first-${tag}`, { timeout: REPLY_MS });

	await page.getByRole('textbox', { name: 'Message' }).fill(`Reply with exactly: second-${tag}`);
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.getByRole('article', { name: 'You' }).last()).toContainText(`second-${tag}`);
	await expect(page.getByRole('article', { name: 'Claude' }).last()).toContainText(`second-${tag}`, { timeout: REPLY_MS });
	await phoneScreenshot('conversation.png');
	await expectNoSidewaysScroll(page);

	const main = page.getByRole('main');
	await main.getByRole('button', { name: 'More' }).click();
	await expect(main.getByRole('button', { name: 'Terminal' })).toBeVisible();
	await expect(main.getByRole('combobox', { name: 'Model' })).toBeVisible();
	await expectNoSidewaysScroll(page);
	await phoneScreenshot('more.png');

	// Android's back gesture closes the conversation and shows the session list again.
	adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
	await expect(page.getByRole('navigation', { name: 'Sessions' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
	await expectNoSidewaysScroll(page);
	await phoneScreenshot('list.png');
	const fingerprint = execFileSync('ssh-keygen', ['-lf', '-'], { input: publicKey, encoding: 'utf8' }).split(' ')[1]!;
	expect(readFileSync(`${SERVER}/sshd.log`, 'utf8')).toContain(`ED25519 ${fingerprint}`);
});

function logins(publicKey: string): number {
	const fingerprint = execFileSync('ssh-keygen', ['-lf', '-'], { input: publicKey, encoding: 'utf8' }).split(' ')[1]!;
	return readFileSync(`${SERVER}/sshd.log`, 'utf8').split('\n').filter((line) => line.includes('Accepted publickey') && line.includes(fingerprint)).length;
}

// Android can freeze or cut off an app in the background; the check drops the connection on the server's side meanwhile, so the app has to log in again when it comes back.
test('back from a minute in the background with its connection gone, orfoni logs in again and shows what the hub reports', async () => {
	const tag = randomUUID().slice(0, 8);
	const publicKey = await logIn(await freshApp());
	expect(logins(publicKey)).toBe(1);
	adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	execFileSync('pkill', ['-P', readFileSync(`${SERVER}/sshd.pid`, 'utf8').trim()]);
	await new Promise((resolve) => setTimeout(resolve, 55_000));
	const page = await appPage();
	await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 60_000 });
	await startSession(`back ${tag}`, 'Reply with exactly: ok');
	await expect(page.getByRole('navigation', { name: 'Sessions' }).getByText(`back ${tag}`)).toBeVisible({ timeout: 30_000 });
	expect(logins(publicKey)).toBeGreaterThan(1);
});

// Only orfoni's own notifications, filtered on the phone, so nothing else on it comes back.
function shownNotifications(): string {
	return adb('shell', `dumpsys notification --noredact | grep -A40 'pkg=${PACKAGE}' | grep -E 'android.title=|android.text=' || true`);
}

// Android asks once whether orfoni may run without battery limits, which it needs for its connection while the phone sleeps.
// The nodes of the screen Android shows now that match the pattern, filtered on the phone, so nothing else on it comes back.
function onScreen(pattern: string): string {
	return adb('shell', `uiautomator dump /sdcard/orfoni-check.xml > /dev/null; grep -oE '${pattern}' /sdcard/orfoni-check.xml; rm /sdcard/orfoni-check.xml`);
}

function center(bounds: string): [string, string] {
	const [x1, y1, x2, y2] = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds)!.slice(1).map(Number);
	return [String(Math.round((x1! + x2!) / 2)), String(Math.round((y1! + y2!) / 2))];
}

async function declineBatteryExemption(): Promise<boolean> {
	for (let i = 0; i < 20; i++) {
		const decline = onScreen('resource-id="android:id/button2"[^>]*package="com.android.settings"[^>]*bounds="[^"]*"');
		if (decline) {
			adb('shell', 'input', 'tap', ...center(decline));
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

async function untilNotified(text: string, timeoutMs: number): Promise<string> {
	return eventually(async () => shownNotifications(), (shown) => shown.includes(text), timeoutMs);
}

test('in the background, a session that needs approval shows a notification on the phone, also while Android dozes and without the battery exemption', async () => {
	const tag = randomUUID().slice(0, 8);
	await logIn(await freshApp());
	expect(adb('shell', 'dumpsys', 'deviceidle', 'whitelist')).not.toContain(PACKAGE);
	await untilNotified('orfoni is connected', 15_000);
	adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
	const ask = 'Use the Write tool to create notice.txt containing hi. Do nothing else.';
	await startSession(`notice ${tag}`, ask);
	expect(await untilNotified(`notice ${tag}`, 90_000)).toContain('Claude needs your approval');

	adb('shell', 'dumpsys', 'battery', 'unplug');
	try {
		expect(adb('shell', 'dumpsys', 'deviceidle', 'force-idle')).toContain('Now forced in to deep idle mode');
		await startSession(`doze ${tag}`, ask);
		expect(await untilNotified(`doze ${tag}`, 90_000)).toContain('Claude needs your approval');
	} finally {
		adb('shell', 'dumpsys', 'deviceidle', 'unforce');
		adb('shell', 'dumpsys', 'battery', 'reset');
	}
});

function keyboardShown(): boolean {
	return adb('shell', 'dumpsys input_method | grep mInputShown').includes('mInputShown=true');
}

// A real touch on the phone at the element's place, which Android treats as a finger, unlike one sent through the WebView.
async function touch(page: Page, element: ReturnType<Page['locator']>): Promise<void> {
	const [left, top] = /\[(\d+),(\d+)\]/.exec(onScreen('class="android.webkit.WebView"[^>]*bounds="[^"]*"'))!.slice(1).map(Number);
	const box = (await element.boundingBox())!;
	const ratio = await page.evaluate(() => devicePixelRatio);
	adb('shell', 'input', 'tap', String(Math.round(left! + (box.x + box.width / 2) * ratio)), String(Math.round(top! + (box.y + box.height / 2) * ratio)));
}

test('on the phone a terminal opens without the keyboard, a tap brings it up, and the row of keys sends Ctrl+C and Shift+Tab with the keyboard staying up', async () => {
	const tag = randomUUID().slice(0, 8);
	const page = await freshApp();
	await logIn(page);
	const id = await startSession(`keys ${tag}`, 'Reply with exactly: ready');
	await page.getByRole('navigation', { name: 'Sessions' }).getByText(`keys ${tag}`).click();
	await expect(page.getByRole('article', { name: 'Claude' }).last()).toContainText('ready', { timeout: REPLY_MS });
	const main = page.getByRole('main');
	await main.getByRole('button', { name: 'More' }).click();
	await main.getByRole('button', { name: 'Terminal' }).click();
	const keys = page.getByRole('group', { name: 'Terminal keys' });
	await expect(keys).toBeVisible();
	const screen = () => tmux('capture-pane', '-p', '-t', pane(id));
	await eventually(async () => screen(), (text) => text.includes('manual mode on'), 30_000);
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	expect(keyboardShown()).toBe(false);

	await touch(page, page.locator('.terminal .screen').last());
	await eventually(async () => keyboardShown(), (shown) => shown, 10_000);
	const fit = await page.evaluate(() => ({ bottom: document.querySelector('[aria-label="Terminal keys"]')!.getBoundingClientRect().bottom, height: innerHeight }));
	expect(Math.abs(fit.bottom - fit.height)).toBeLessThan(2);
	await phoneScreenshot('terminal-keys.png');

	// One key at a time, as a person types: xterm reads what Android's keyboard put into its text field after each key, so keys injected in one burst would overlap. Starting with a digit keeps the keyboard from capitalizing the first letter.
	for (const char of `42${tag}`) adb('shell', 'input', 'text', char);
	await eventually(async () => screen(), (text) => text.includes(`42${tag}`), 10_000);
	await touch(page, keys.getByRole('button', { name: 'Ctrl' }));
	await expect(keys.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'true');
	adb('shell', 'input', 'text', 'c');
	await eventually(async () => screen(), (text) => !text.includes(`42${tag}`), 10_000);
	await expect(keys.getByRole('button', { name: 'Ctrl' })).toHaveAttribute('aria-pressed', 'false');

	await touch(page, keys.getByRole('button', { name: 'Shift+Tab' }));
	await eventually(async () => screen(), (text) => text.includes('accept edits on'), 10_000);
	expect(keyboardShown()).toBe(true);
});

test('a tap on the notification of a session that needs approval opens orfoni on that session', async () => {
	const tag = randomUUID().slice(0, 8);
	const page = await freshApp();
	await logIn(page);
	await untilNotified('orfoni is connected', 15_000);
	adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
	await startSession(`tap ${tag}`, 'Use the Write tool to create notice.txt containing hi. Do nothing else.');
	await untilNotified(`tap ${tag}`, 90_000);
	adb('shell', 'cmd', 'statusbar', 'expand-notifications');
	try {
		// Android bundles an app's notifications under one heading, and a tap on a line of a closed bundle opens the bundle, so a second tap opens the notification, as it takes a person.
		for (let attempt = 0; attempt < 3 && !adb('shell', 'dumpsys window | grep -m1 mCurrentFocus || true').includes(PACKAGE); attempt++) {
			const shown = await eventually(async () => onScreen(`text="tap ${tag}"[^>]*bounds="[^"]*"`), (node) => node !== '', 10_000);
			adb('shell', 'input', 'tap', ...center(shown));
			await new Promise((resolve) => setTimeout(resolve, 1_500));
		}
	} finally {
		adb('shell', 'cmd', 'statusbar', 'collapse');
	}
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1, name: `tap ${tag}` })).toBeVisible({ timeout: 15_000 });
	await expect(main.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
});
