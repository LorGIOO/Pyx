import { createSignal } from 'solid-js';

// Active ribbon tab. 'home' is shown on launch.
export const [activeTab, setActiveTab] = createSignal('home');
