import { filterServices } from './registry';
import type { ServiceEntry } from './types';

const SERVICES: ServiceEntry[] = [
  {
    id: 1,
    name: 'Alpha Weather',
    description: 'Hourly weather forecasts for agents',
    endpoint: 'https://weather.example.com',
    price_usdc: '1.50',
    category: 'weather',
    provider: 'GBALPHA123',
    reputation: 10,
    active: true,
    registered_at: 100,
  },
  {
    id: 2,
    name: 'Beta Search',
    description: 'Web results and snippets',
    endpoint: 'https://search.example.com',
    price_usdc: '0.25',
    category: 'search',
    provider: 'GBBETA123',
    reputation: 30,
    active: true,
    registered_at: 300,
  },
  {
    id: 3,
    name: 'Gamma Data',
    description: 'Weather archives and climate datasets',
    endpoint: 'https://data.example.com',
    price_usdc: '0.75',
    category: 'data',
    provider: 'GBGAMMA123',
    reputation: 30,
    active: true,
    registered_at: 200,
  },
];

// sortServices tests removed (moved to sort.test.ts)

describe('filterServices', () => {
  it('returns all services when the query is empty', () => {
    expect(filterServices(SERVICES, '   ')).toEqual(SERVICES);
  });

  it('matches service names case-insensitively', () => {
    expect(filterServices(SERVICES, 'beta').map((service) => service.id)).toEqual([2]);
  });

  it('matches service descriptions case-insensitively', () => {
    expect(filterServices(SERVICES, 'climate').map((service) => service.id)).toEqual([3]);
  });

  it('returns multiple matches when the query appears in multiple services', () => {
    expect(filterServices(SERVICES, 'weather').map((service) => service.id)).toEqual([1, 3]);
  });

  it('matches a service that would only appear on a later page', () => {
    // Build a 14-service array (PAGE_SIZE = 12, so service 14 lives on page 2).
    // Only the last entry contains the keyword "needle" — a search for "needle"
    // must still return it even though it is beyond the first page boundary.
    const PAGE_SIZE = 12;
    const manyServices: ServiceEntry[] = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => ({
      id: i + 1,
      name: `Service ${i + 1}`,
      description: i === PAGE_SIZE + 1 ? 'This service contains the needle keyword' : `Description ${i + 1}`,
      endpoint: `https://example.com/${i + 1}`,
      price_usdc: '0.10',
      category: 'data' as const,
      provider: 'GBPROVIDER123',
      reputation: 50,
      active: true,
      registered_at: i,
    }));

    // The matching service is at index PAGE_SIZE + 1, well beyond page 1.
    const results = filterServices(manyServices, 'needle');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(PAGE_SIZE + 2); // id = index + 1
    expect(results[0].description).toContain('needle');
  });
});
