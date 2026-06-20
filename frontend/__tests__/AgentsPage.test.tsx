import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import AgentsPage, { PAGE_SIZE } from '../app/agents/page';
import type { AgentEntry, AgentStats } from '@/lib/types';

// Wrap in a fresh SWR cache per render so cached data never leaks between tests,
// and disable deduping so each test's mock fetch is actually invoked.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentsPage />
    </SWRConfig>
  );
}

jest.mock('@/lib/contract', () => ({
  fetchAgents: jest.fn(),
  fetchAgentStats: jest.fn(),
}));

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  MockLink.displayName = 'Link';
  return MockLink;
});

import { fetchAgents, fetchAgentStats } from '@/lib/contract';

const mockAgent: AgentEntry = {
  address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUV',
  name: 'Demo Agent',
  description: 'Handles demo requests',
  owner: 'GOWNER',
  score: 820,
  total_payments: 10,
  successful_payments: 9,
  failed_payments: 1,
  total_volume_stroops: '10000000',
  registered_at: 12345,
  last_active: 12350,
  active: true,
  flagged: false,
  flag_reason: '',
};

const mockStats: AgentStats = {
  totalAgents: 1,
  avgScore: 820,
  topAgent: mockAgent,
  totalVolume: '1.00',
};

describe('AgentsPage retry state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets users retry after the agents request fails', async () => {
    (fetchAgents as jest.Mock)
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValueOnce({ agents: [mockAgent], total: 1, page: 0, pageSize: PAGE_SIZE });
    (fetchAgentStats as jest.Mock).mockResolvedValue(mockStats);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network disconnected')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryAllByText('Demo Agent').length).toBeGreaterThan(0);
    });
    expect(fetchAgents).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Network disconnected')).not.toBeInTheDocument();
  });
});
