import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockListServices = vi.fn();
const mockRegisterServiceOnChain = vi.fn();

vi.mock('../src/lib/contract.js', () => ({
  listServices: mockListServices,
  registerServiceOnChain: mockRegisterServiceOnChain,
}));

vi.mock('../src/lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('update-endpoints', () => {
  let processExitSpy;
  let mod;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.BACKEND_URL = 'https://example.com';
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    mod = await import('./update-endpoints.js');
  });

  afterEach(() => {
    delete process.env.BACKEND_URL;
  });

  it('replaces localhost endpoints with BACKEND_URL', async () => {
    mockListServices.mockResolvedValueOnce([
      {
        name: 'Weather',
        description: 'Weather data',
        endpoint: 'http://localhost:3001/weather',
        price_usdc: '0.001',
        category: 'weather',
      },
    ]);
    mockListServices.mockResolvedValueOnce([]);
    mockRegisterServiceOnChain.mockResolvedValue(42);

    await mod.update();

    expect(mockListServices).toHaveBeenCalledWith('weather');
    expect(mockListServices).toHaveBeenCalledWith('search');
    expect(mockRegisterServiceOnChain).toHaveBeenCalledWith(
      'Weather',
      'Weather data',
      'https://example.com/weather',
      '0.001',
      'weather',
    );
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('skips update when no localhost endpoints exist', async () => {
    mockListServices.mockResolvedValueOnce([
      {
        name: 'Weather',
        description: 'Weather data',
        endpoint: 'https://example.com/weather',
        price_usdc: '0.001',
        category: 'weather',
      },
    ]);
    mockListServices.mockResolvedValueOnce([]);

    await mod.update();

    const logger = (await import('../src/lib/logger.js')).default;
    expect(logger.info).toHaveBeenCalledWith(
      'All endpoints already point to the deployed host — nothing to do',
    );
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('logs error and exits with 1 when contract call fails', async () => {
    const testErr = new Error('RPC failure');
    mockListServices.mockRejectedValue(testErr);

    await mod.update();

    const logger = (await import('../src/lib/logger.js')).default;
    expect(logger.error).toHaveBeenCalledWith({ err: testErr }, 'update-endpoints failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('processes both weather and search services', async () => {
    mockListServices.mockResolvedValueOnce([
      {
        name: 'Weather', description: 'Weather', endpoint: 'http://localhost:3001/weather',
        price_usdc: '0.001', category: 'weather',
      },
      {
        name: 'Weather2', description: 'More weather', endpoint: 'http://localhost:3001/weather2',
        price_usdc: '0.002', category: 'weather',
      },
    ]);
    mockListServices.mockResolvedValueOnce([
      {
        name: 'Search', description: 'Search', endpoint: 'http://localhost:3001/search',
        price_usdc: '0.001', category: 'search',
      },
    ]);
    mockRegisterServiceOnChain.mockResolvedValue(1);

    await mod.update();

    expect(mockRegisterServiceOnChain).toHaveBeenCalledTimes(3);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
