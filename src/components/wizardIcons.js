import { createElement } from 'react';
import {
  Atom,
  Ban,
  Braces,
  Brush,
  Code,
  Component,
  FileCode,
  FilePlus,
  Flame,
  FlaskConical,
  Gem,
  Globe,
  Layers,
  Link,
  Monitor,
  Package,
  Palette,
  Route,
  Server,
  Shield,
  SquareTerminal,
  Terminal,
  WandSparkles,
  Waves,
  Zap,
} from 'lucide-react';

/**
 * wizardIcons.js — the New Project wizard's icon vocabulary
 * (brief-wizard-robustness.md, slice 4).
 *
 * Card data names an icon by KEY; this map is the only place a key meets a
 * glyph. Every glyph is a Lucide category icon (ISC): no brand logos, so
 * every card carries the same visual weight and no mark needs a trademark
 * review. Add a key here before using it in card data —
 * test/domains/wizardIcons.test.mjs fails on a key with no glyph.
 */
export const WIZARD_ICONS = Object.freeze({
  // Runtime wrappers
  monitor: Monitor,          // Tauri — native desktop window
  zap: Zap,                  // Electron / Fastify — fast, electric
  globe: Globe,              // Web only
  terminal: Terminal,        // Python runtime + language
  'file-plus': FilePlus,     // Blank — just the essentials
  // Frameworks
  atom: Atom,                // React
  flame: Flame,              // Svelte
  layers: Layers,            // Vue
  shield: Shield,            // Angular
  gem: Gem,                  // Solid
  // Languages
  braces: Braces,            // TypeScript
  code: Code,                // JavaScript
  // Backends
  ban: Ban,                  // None
  server: Server,            // Express / FastAPI service
  // Add-ons
  waves: Waves,              // Tailwind
  component: Component,      // ShadCN
  route: Route,              // Router
  'flask-conical': FlaskConical, // pytest
  brush: Brush,              // Ruff
  // Python archetypes
  'file-code': FileCode,     // Script
  'square-terminal': SquareTerminal, // CLI app
  package: Package,          // Library
  // Workspace colour modes
  'wand-sparkles': WandSparkles, // Auto groups
  palette: Palette,          // Custom default
  link: Link,                // Inherit group
});

export const WIZARD_ICON_NAMES = Object.freeze(Object.keys(WIZARD_ICONS));

/**
 * Renders the glyph for a card. Decorative by contract (the card's name is
 * the accessible label), so it is always aria-hidden.
 */
export function WizardIcon({ name, size = 17, strokeWidth = 1.75, ...rest }) {
  const Glyph = WIZARD_ICONS[name];
  if (!Glyph) return null;
  return createElement(Glyph, { size, strokeWidth, 'aria-hidden': true, ...rest });
}
