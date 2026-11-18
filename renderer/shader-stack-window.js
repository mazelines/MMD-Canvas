import { setLanguage, translateStatic } from '../src/i18n/index.js';
import { ShaderStackPanel } from './shader-stack-panel.js';

// Editor-only window: the stack state lives in the main process; applying shaders
// re-renders the main viewport. This window just edits code/stack/properties.
const api = window.api;
const startup = await api.startup();
setLanguage(startup.locale);
translateStatic(document.body);

const panel = new ShaderStackPanel();
await panel.load();
// Refresh when the stack changes elsewhere (e.g. a workspace restore).
api.onShaderStackUpdated(layers => panel.setStack(layers));
