import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { _android, expect, test, type AndroidDevice, type Page } from '@playwright/test';
import type { SessionId } from '@orfoni/protocol';
import { acceptTrustPrompt, HubClient, newProjectDir, type Started } from '../../hub/test/e2e/client';

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
	adb('shell', `run-as ${PACKAGE} rm -rf settings.json known-hosts.json ssh`);
	adb('shell', 'am', 'start', '-n', `${PACKAGE}/com.orfoni.app.MainActivity`);
	const webview = await device.webView({ pkg: PACKAGE }, { timeout: 30_000 });
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

test('on the phone, orfoni makes its own key, logs in with it, and gets Claude to answer a message sent from the phone', async () => {
	const tag = randomUUID().slice(0, 8);
	const page = await freshApp();
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

	const result = (await hub.request('startSession', { projectDir: newProjectDir(), model: 'haiku', permissionMode: 'default', title: `phone ${tag}`, prompt: `Reply with exactly: first-${tag}` })) as Started;
	started.push(result.session.id);
	await acceptTrustPrompt(result);
	await page.getByRole('navigation', { name: 'Sessions' }).getByText(`phone ${tag}`).click();
	await expect(page.getByRole('article', { name: 'Claude' }).last()).toContainText(`first-${tag}`, { timeout: REPLY_MS });

	await page.getByRole('textbox', { name: 'Message' }).fill(`Reply with exactly: second-${tag}`);
	await page.getByRole('button', { name: 'Send' }).click();
	await expect(page.getByRole('article', { name: 'You' }).last()).toContainText(`second-${tag}`);
	await expect(page.getByRole('article', { name: 'Claude' }).last()).toContainText(`second-${tag}`, { timeout: REPLY_MS });
	await page.screenshot({ path: test.info().outputPath('answered.png') });
	const fingerprint = execFileSync('ssh-keygen', ['-lf', '-'], { input: publicKey, encoding: 'utf8' }).split(' ')[1]!;
	expect(readFileSync(`${SERVER}/sshd.log`, 'utf8')).toContain(`Accepted publickey for root from 127.0.0.1`);
	expect(readFileSync(`${SERVER}/sshd.log`, 'utf8')).toContain(`ED25519 ${fingerprint}`);
});
