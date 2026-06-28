import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import '@testing-library/jest-dom';
import RegistryPage from '../app/registry/page';
import { PAGE_SIZE } from '../lib/pagination';
import { fetchServices } from '@/lib/contract';

jest.mock('@/lib/contract', () => ({
  fetchServices: jest.fn(),
  submitReputation: jest.fn(),
}));

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RegistryPage />
    </SWRConfig>
  );
}

function makeServices(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Service ${i + 1}`,
    name: `Service ${i + 1}`,
    description: `Description ${i + 1}`,
    endpoint: `https://example.com/${i + 1}`,
    price_usdc: `${(i + 1) * 0.5}`,
    category: 'ai',
    provider: `G${String(i + 1).padStart(55, 'A')}`,
    reputation: i + 1,
    active: true,
    is_demo: false,
    registered_at: Date.now(),
  }));
}

describe('RegistryPage loading state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows skeleton cards while loading', () => {
    (fetchServices as jest.Mock).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getAllByTestId('service-card-skeleton')).toHaveLength(4);
  });
});

describe('RegistryPage empty state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows an empty-registry message when no services are returned', async () => {
    (fetchServices as jest.Mock).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/registry is empty/i)).toBeInTheDocument();
  });
});

describe('RegistryPage pagination — basic rendering', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders pagination controls when results exceed one page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    renderPage();
    expect(await screen.findByRole('button', { name: /next page/i })).toBeInTheDocument();
  });
});

describe('RegistryPage pagination — controls', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows pagination controls when there is more than one page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 2));
    renderPage();
    await screen.findByRole('button', { name: /next page/i });
    expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
  });

  it('advances to page 2 and disables Next on the last page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 2));
    renderPage();
    const next = await screen.findByRole('button', { name: /next page/i });
    fireEvent.click(next);
    await waitFor(() => expect(next).toBeDisabled());
  });
});
