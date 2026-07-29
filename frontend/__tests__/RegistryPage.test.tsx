import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';
import RegistryPage from '../app/registry/page';
import { PAGE_SIZE } from '@/lib/pagination';

jest.mock('@/lib/contract', () => ({
  fetchServices: jest.fn(),
}));

import { fetchServices } from '@/lib/contract';

function makeServices(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Service ${i + 1}`,
    description: `Description ${i + 1}`,
    endpoint: `https://example.com/${i + 1}`,
    price_usdc: '0.001',
    category: 'weather',
    provider: `G${'A'.repeat(55)}`,
    reputation: 100,
    active: true,
    registered_at: 1000 + i,
  }));
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RegistryPage />
    </SWRConfig>
  );
}

describe('RegistryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows skeleton cards while loading', () => {
    (fetchServices as jest.Mock).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getAllByTestId('service-card-skeleton')).toHaveLength(4);
  });

  it('shows empty-registry message when no services', async () => {
    (fetchServices as jest.Mock).mockResolvedValue({
      services: [],
      total: 0,
      count: 0,
      page: 0,
      pageSize: PAGE_SIZE,
    });

    renderPage();
    expect(await screen.findByText(/registry is empty/i)).toBeInTheDocument();
  });

  it('renders services from API without pagination when within one page', async () => {
    const services = makeServices(PAGE_SIZE - 1);
    (fetchServices as jest.Mock).mockResolvedValue({
      services,
      total: services.length,
      count: services.length,
      page: 0,
      pageSize: PAGE_SIZE,
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE - 1);
    });
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });

  it('shows pagination when results exceed one page', async () => {
    const total = PAGE_SIZE + 5;
    (fetchServices as jest.Mock).mockResolvedValue({
      services: makeServices(PAGE_SIZE),
      total,
      count: PAGE_SIZE,
      page: 0,
      pageSize: PAGE_SIZE,
    });

    renderPage();
    expect(await screen.findByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`of ${total}`))).toBeInTheDocument();
  });

  it('refetches with sort when the user changes the sort control', async () => {
    (fetchServices as jest.Mock).mockResolvedValue({
      services: makeServices(2),
      total: 2,
      count: 2,
      page: 0,
      pageSize: PAGE_SIZE,
    });

    renderPage();

    await waitFor(() => {
      expect(fetchServices).toHaveBeenCalledWith(undefined, 0, PAGE_SIZE, 'newest', '');
    });

    fireEvent.change(screen.getByLabelText(/sort services/i), {
      target: { value: 'price' },
    });

    await waitFor(() => {
      expect(fetchServices).toHaveBeenCalledWith(undefined, 0, PAGE_SIZE, 'price', '');
    });
  });

  it('requests the next page when pagination advances', async () => {
    (fetchServices as jest.Mock).mockResolvedValue({
      services: makeServices(PAGE_SIZE),
      total: PAGE_SIZE + 1,
      count: PAGE_SIZE,
      page: 0,
      pageSize: PAGE_SIZE,
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => {
      expect(fetchServices).toHaveBeenCalledWith(undefined, 1, PAGE_SIZE, 'newest', '');
    });
  });
});
