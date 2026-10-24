export const CATEGORIES = ['search', 'weather', 'finance', 'ai', 'data', 'compute'] as const;

export type Category = (typeof CATEGORIES)[number];

export function normalizeCategory(value: string): Category | null {
  const normalized = value.trim().toLowerCase();
  return CATEGORIES.includes(normalized as Category) ? (normalized as Category) : null;
}
