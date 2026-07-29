/**
 * Automated WCAG AA contrast-ratio checks.
 *
 * After any design-token change these assertions will immediately flag
 * colours that drop below the AA threshold, preventing silent regressions.
 *
 * WCAG 2.1 reference: https://www.w3.org/TR/WCAG21/#contrast-minimum
 *   Normal text (< 18pt / < 14pt bold):  4.5 : 1
 *   Large  text (≥ 18pt / ≥ 14pt bold):  3.0 : 1
 */

/* ------------------------------------------------------------------ */
/*  Relative luminance helpers (sRGB, WCAG formula)                    */
/* ------------------------------------------------------------------ */

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ------------------------------------------------------------------ */
/*  Design tokens (must stay in sync with tailwind.config.ts)          */
/* ------------------------------------------------------------------ */

const BACKGROUND = '#FAFAF7';
const FOREGROUND = '#1A1A1A';
const WHITE = '#FFFFFF';

// Token → hex value (as defined in globals.css & tailwind.config.ts)
const TOKENS: Record<string, string> = {
  primary: '#1A1A1A',
  secondary: '#6B6B6B',
  accent: '#C2410C',
  border: '#E5E5E5',
  success: '#15803D',
  error: '#DC2626',
  background: '#FAFAF7',
};

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('WCAG AA colour contrast', () => {
  // ── Text on background ───────────────────────────────────────────
  describe('text on background (#FAFAF7)', () => {
    const pairs: [string, string, number][] = [
      // [token, bg, minimum expected ratio]
      ['primary', BACKGROUND, 4.5],
      ['secondary', BACKGROUND, 4.5],
      ['accent', BACKGROUND, 4.5],
      ['success', BACKGROUND, 4.5],
      ['error', BACKGROUND, 4.5],
    ];

    test.each(pairs)('%s on bg (#FAFAF7)', (token, bg, min) => {
        const hex = TOKENS[token];
        const ratio = contrastRatio(hex, bg);
        expect(ratio).toBeGreaterThanOrEqual(min);
    });
  });

  // ── White text on coloured backgrounds (buttons, badges, etc.) ───
  describe('white text on coloured backgrounds', () => {
    const pairs: [string, number][] = [
      ['primary', 4.5],
      ['accent', 4.5],
      ['success', 4.5],
      ['error', 4.5],
    ];

    test.each(pairs)('white on %s', (token, min) => {
        const bg = TOKENS[token];
        const ratio = contrastRatio(WHITE, bg);
        expect(ratio).toBeGreaterThanOrEqual(min);
    });
  });

  // ── Foreground text on white (cards) ─────────────────────────────
  describe('text on white (#FFFFFF)', () => {
    const pairs: [string, number][] = [
      ['primary', 4.5],
      ['secondary', 4.5],
      ['accent', 4.5],
      ['success', 4.5],
      ['error', 4.5],
    ];

    test.each(pairs)('%s on white', (token, min) => {
        const hex = TOKENS[token];
        const ratio = contrastRatio(hex, WHITE);
        expect(ratio).toBeGreaterThanOrEqual(min);
    });
  });

  // ── Large-text pairings (≥ 3:1 threshold) ────────────────────────
  describe('large-text pairings (≥ 3:1)', () => {
    test('accent on background meets large-text threshold', () => {
      // accent is used at text-lg (18px) for hero headings
      const ratio = contrastRatio(TOKENS.accent, BACKGROUND);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });
  });

  // ── Sanity: all tokens are defined ────────────────────────────────
  test('all required tokens have hex values', () => {
    for (const [name, hex] of Object.entries(TOKENS)) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
