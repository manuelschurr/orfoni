#!/usr/bin/env node
// Checks an update manifest the way the Windows app's updater will: each platform's installer must carry a minisign signature that the public key in tauri.conf.json verifies. Takes the manifest's path or URL, the live one by default, and optionally a folder holding the installers, to check them before they are published.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIVE = 'https://github.com/manuelschurr/orfoni/releases/latest/download/latest.json';
const [where = LIVE, folder] = process.argv.slice(2);

async function load(location) {
	if (!/^https:/.test(location)) return readFile(location);
	const response = await fetch(location);
	if (!response.ok) throw new Error(`${location} answered ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

// A minisign key or signature file holds a comment line, then a base64 line: two bytes of algorithm, the eight-byte key id, then the key or the signature.
function lines(base64) {
	return Buffer.from(base64.trim(), 'base64').toString('utf8').split('\n');
}

const config = JSON.parse(await readFile(new URL('../app/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const publicKey = Buffer.from(lines(config.plugins.updater.pubkey)[1], 'base64');
const keyId = publicKey.subarray(2, 10);
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.subarray(10)]), format: 'der', type: 'spki' });

function check(installer, signature) {
	const [, signed, trusted, global] = lines(signature);
	const bytes = Buffer.from(signed, 'base64');
	const algorithm = bytes.subarray(0, 2).toString();
	if (!bytes.subarray(2, 10).equals(keyId)) throw new Error('signed with another key than the one in tauri.conf.json');
	const message = algorithm === 'ED' ? createHash('blake2b512').update(installer).digest() : installer;
	if (!verify(null, message, key, bytes.subarray(10))) throw new Error('the signature does not match the installer');
	const comment = Buffer.from(trusted.replace(/^trusted comment: /, ''));
	if (!verify(null, Buffer.concat([bytes.subarray(10), comment]), key, Buffer.from(global, 'base64'))) throw new Error('the signature\'s trusted comment was altered');
}

const manifest = JSON.parse((await load(where)).toString('utf8'));
const platforms = Object.entries(manifest.platforms ?? {});
if (platforms.length === 0) throw new Error(`${where} names no platforms`);
for (const [platform, { url, signature }] of platforms) {
	const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
	check(await load(folder ? join(folder, name) : url), signature);
	console.log(`${platform} ${manifest.version}: ${name} verified`);
}
