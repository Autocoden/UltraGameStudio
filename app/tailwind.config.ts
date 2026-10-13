import type { Config } from 'tailwindcss';

/**
 * Wrap a CSS custom property so Tailwind can apply `/NN` opacity modifiers.
 *
 * A color declared as a bare `var(--x)` cannot carry an alpha channel, so Tailwind
 * silently emits **no rule at all** for `bg-accent/10`, `border-status-error/40`,
 * `ring-status-success/20`, … — the markup looks right and renders nothing. (Before
 * this helper the source used `bg-accent/10` 48 times and the built stylesheet
 * contained zero `.bg-accent\/10` rules.)
 *
 * `color-mix(in srgb, C P%, transparent)` is exactly `C` at alpha `P/100`, so the
 * solid form (`bg-accent`) still resolves to the untouched token value.
 */
const token = (variable: string): string =>
  `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: token('--bg'),
        'bg-alt': token('--bg-alt'),
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        border: token('--border'),
        'border-soft': token('--border-soft'),
        fg: token('--fg'),
        'fg-dim': token('--fg-dim'),
        'fg-faint': token('--fg-faint'),
        accent: token('--accent'),
        'accent-2': token('--accent-2'),
        'accent-3': token('--accent-3'),
        'accent-4': token('--accent-4'),
        'status-ai-edit': token('--status-ai-edit'),
        'status-ai-edit-contrast': token('--status-ai-edit-contrast'),
        'status-running': token('--status-running'),
        'status-running-contrast': token('--status-running-contrast'),
        'status-success': token('--status-success'),
        'status-success-contrast': token('--status-success-contrast'),
        'status-error': token('--status-error'),
        'status-error-contrast': token('--status-error-contrast'),
        'status-interrupted': token('--status-interrupted'),
        'status-interrupted-contrast': token('--status-interrupted-contrast'),
        'status-draft': token('--status-draft'),
        'status-draft-contrast': token('--status-draft-contrast'),
        'status-info': token('--status-info'),
        'status-info-contrast': token('--status-info-contrast'),
        'status-warning': token('--status-warning'),
        'status-warning-contrast': token('--status-warning-contrast'),
      },
      fontFamily: {
        // Kept in sync with --ugs-font-family / --ugs-mono-font-family in
        // styles/global.css. The CJK faces matter for both: Inter and JetBrains
        // Mono carry no hanzi/kana, so without them every CJK glyph falls back
        // per-glyph with mismatched metrics.
        sans: [
          'Inter',
          'PingFang SC',
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          'Noto Sans SC',
          'Noto Sans CJK SC',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Sarasa Mono SC"',
          '"Noto Sans Mono CJK SC"',
          '"Cascadia Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
