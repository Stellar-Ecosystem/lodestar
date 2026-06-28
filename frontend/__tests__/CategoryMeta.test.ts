import { CATEGORY_FILTERS, CATEGORY_ICONS, CATEGORY_META, getCategoryMeta } from '../lib/categoryMeta';

describe('category metadata', () => {
  it('exposes icon and label metadata for every service category', () => {
    expect(getCategoryMeta('search')).toMatchObject({
      label: 'Search',
      icon: CATEGORY_ICONS.search,
    });
    expect(getCategoryMeta('finance')).toMatchObject({
      label: 'Finance',
      icon: CATEGORY_ICONS.finance,
    });
    expect(Object.keys(CATEGORY_META)).toEqual([
      'search',
      'weather',
      'finance',
      'ai',
      'data',
      'compute',
    ]);
  });

  it('keeps registry filters in sync with category metadata', () => {
    const searchFilter = CATEGORY_FILTERS.find((filter) => filter.value === 'search');

    expect(CATEGORY_FILTERS[0]).toEqual({ label: 'All', value: 'all' });
    expect(searchFilter).toEqual({
      label: CATEGORY_META.search.label,
      value: 'search',
    });
  });

  it('exposes shared SVG icons for each category', () => {
    expect(CATEGORY_ICONS.weather.props['data-category-icon']).toBe('weather');
    expect(CATEGORY_ICONS.data.type).toBe('svg');
  });

  it('falls back safely for unexpected category values', () => {
    expect(getCategoryMeta('unknown-category')).toMatchObject({
      label: 'Unknown',
      badgeClass: 'bg-gray-50 text-gray-700',
    });
    expect(getCategoryMeta('constructor')).toMatchObject({
      label: 'Unknown',
      badgeClass: 'bg-gray-50 text-gray-700',
    });
  });
});
