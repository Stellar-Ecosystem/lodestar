import { sortServices, sortAgents, sortServicesWithTieBreaker, sortAgentsWithTieBreaker } from './sort';
import type { ServiceEntry, AgentEntry } from './types';

const svc = (overrides: Partial<ServiceEntry> = {}): ServiceEntry => ({
  id: 1,
  name: 'Test',
  description: 'desc',
  endpoint: 'https://test.com',
  price_usdc: '1.0',
  category: 'ai',
  provider: 'GABC',
  reputation: 5,
  active: true,
  registered_at: 100,
  ...overrides,
});

const agent = (overrides: Partial<AgentEntry> = {}): AgentEntry => ({
  address: 'GABC',
  name: 'Agent',
  description: 'desc',
  owner: 'GABC',
  score: 50,
  total_payments: '10',
  successful_payments: '8',
  failed_payments: '2',
  total_volume_stroops: '1000',
  registered_at: '100',
  last_active: '200',
  active: true,
  flagged: false,
  flag_reason: '',
  is_demo: false,
  ...overrides,
});

describe('sortServices', () => {
  it('sorts by newest (highest registered_at first)', () => {
    const items = [svc({ registered_at: 1 }), svc({ registered_at: 3 }), svc({ registered_at: 2 })];
    const sorted = sortServices(items, 'newest');
    expect(sorted.map(s => s.registered_at)).toEqual([3, 2, 1]);
  });

  it('sorts by reputation (highest first)', () => {
    const items = [svc({ reputation: 1 }), svc({ reputation: 9 }), svc({ reputation: 5 })];
    const sorted = sortServices(items, 'reputation');
    expect(sorted.map(s => s.reputation)).toEqual([9, 5, 1]);
  });

  it('sorts by price (lowest first)', () => {
    const items = [svc({ price_usdc: '10' }), svc({ price_usdc: '1' }), svc({ price_usdc: '5' })];
    const sorted = sortServices(items, 'price');
    expect(sorted.map(s => s.price_usdc)).toEqual(['1', '5', '10']);
  });

  it('does not mutate the original array', () => {
    const items = [svc({ registered_at: 2 }), svc({ registered_at: 1 })];
    sortServices(items, 'newest');
    expect(items[0].registered_at).toBe(2);
  });
});

describe('sortAgents', () => {
  it('sorts by score (highest first)', () => {
    const items = [agent({ score: 10 }), agent({ score: 90 }), agent({ score: 50 })];
    const sorted = sortAgents(items, 'score');
    expect(sorted.map(a => a.score)).toEqual([90, 50, 10]);
  });

  it('sorts by payments (highest first)', () => {
    const items = [agent({ total_payments: '2' }), agent({ total_payments: '10' }), agent({ total_payments: '5' })];
    const sorted = sortAgents(items, 'payments');
    expect(sorted.map(a => a.total_payments)).toEqual(['10', '5', '2']);
  });

  it('sorts by newest (highest registered_at first)', () => {
    const items = [agent({ registered_at: '1' }), agent({ registered_at: '3' }), agent({ registered_at: '2' })];
    const sorted = sortAgents(items, 'newest');
    expect(sorted.map(a => a.registered_at)).toEqual(['3', '2', '1']);
  });
});

describe('sortServicesWithTieBreaker', () => {
  it('applies tie-breaker when values are equal', () => {
    const a = svc({ reputation: 5, name: 'A' });
    const b = svc({ reputation: 5, name: 'B' });
    const sorted = sortServicesWithTieBreaker([a, b], 'reputation', (x, y) => x.name.localeCompare(y.name));
    expect(sorted[0].name).toBe('A');
    expect(sorted[1].name).toBe('B');
  });
});

describe('sortAgentsWithTieBreaker', () => {
  it('applies tie-breaker when scores are equal', () => {
    const a = agent({ score: 50, name: 'Alpha' });
    const b = agent({ score: 50, name: 'Beta' });
    const sorted = sortAgentsWithTieBreaker([a, b], 'score', (x, y) => x.name.localeCompare(y.name));
    expect(sorted[0].name).toBe('Alpha');
    expect(sorted[1].name).toBe('Beta');
  });
});
