import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentsPage, { PAGE_SIZE } from '../app/agents/page';
import type { AgentEntry, AgentStats } from '@/lib/types';

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

function makeAgent(i: number): AgentEntry {
  return {
    address: `ADDR${i}`,
    name: `Agent ${i}`,
    description: `desc ${i}`,
    owner: `OWNER${i}`,
    score: 1000 - i,
    total_payments: 10 - (i % 10),
    successful_payments: 10 - (i % 10),
    failed_payments: 0,
    total_volume_stroops: '0',
    registered_at: 1000 - i,
    last_active: 1000 - i,
    active: true,
    flagged: false,
    flag_reason: '',
  };
}

const MOCK_STATS: AgentStats = {
  totalAgents: 25,
  avgScore: 500,
  topAgent: null,
  totalVolume: '0',
};

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


  });
});

describe('AgentsPage retry state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets users retry after the agents request fails', async () => {
    (fetchAgents as jest.Mock)
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValueOnce({ agents: [mockAgent], total: 1, page: 0, pageSize: PAGE_SIZE });
    (fetchAgentStats as jest.Mock).mockResolvedValue(mockStats);

    render(<AgentsPage />);

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
