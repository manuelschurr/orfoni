import { mount } from 'svelte';
import App from './App.svelte';
import { probeHub } from './lib/debug-probe';
import { TauriHubTransport } from './lib/tauri-transport';

const app = mount(App, { target: document.getElementById('app')! });

if ('__TAURI_INTERNALS__' in window) void probeHub(new TauriHubTransport());

export default app;
