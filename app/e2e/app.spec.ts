import { expect, test } from '@playwright/test';
import { Hub, newProjectDir } from './hub';

let hub: Hub;

test.beforeEach(async () => {
	hub = await Hub.connect();
});

test.afterEach(async () => {
	await hub.removeOurs();
	hub.close();
});

test('the session list loads', async ({ page }) => {
	await hub.start({ projectDir: newProjectDir(), title: 'list check' });
	const sessions = await hub.sessions();
	await page.goto('/?transport=ws');
	for (const session of sessions) await expect(page.locator(`[data-session="${session.id}"]`)).toBeVisible();
});
