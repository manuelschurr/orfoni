import { mount } from 'svelte';
import App from './App.svelte';
import './lib/ui/theme.css';

export default mount(App, { target: document.getElementById('app')! });
