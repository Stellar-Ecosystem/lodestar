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

function setupMockFetchAgents(total: number) {
  (fetchAgents as jest.Mock).mockImplementation((page = 0, pageSize = PAGE_SIZE) => {
    const start = page * pageSize;
    const remaining = Math.max(0, total - start);
    const agents = Array.from(
      { length: Math.min(pageSize, remaining) },
      (_, i) => makeAgent(start + i)
    );
    return Promise.resolve({ agents, total, page, pageSize });
  });
}

describe('AgentsPage pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (fetchAgentStats as jest.Mock).mockResolvedValue(MOCK_STATS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function renderWithTotal(total: number) {
    setupMockFetchAgents(total);
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Agent 0')).toBeInTheDocument();
    });
  }

  it(`renders only ${PAGE_SIZE} agents on the first page when there are more`, async () => {
    await renderWithTotal(PAGE_SIZE + 5);

    expect(screen.getByText('Agent 0')).toBeInTheDocument();
    expect(screen.getByText(`Agent ${PAGE_SIZE - 1}`)).toBeInTheDocument();
    expect(screen.queryByText(`Agent ${PAGE_SIZE}`)).not.toBeInTheDocument();
  });

  it('shows pagination controls only when total exceeds PAGE_SIZE', async () => {
    await renderWithTotal(PAGE_SIZE + 1);

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  });

  it('does not render pagination controls when agents fit on one page', async () => {
    await renderWithTotal(PAGE_SIZE - 1);

    expect(screen.queryByRole('button', { name: 'Previous page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('Prev button is disabled on the first page', async () => {
    await renderWithTotal(PAGE_SIZE + 1);

    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).not.toBeDisabled();
  });

  it('calls fetchAgents with page=1 when Next is clicked', async () => {
    await renderWithTotal(PAGE_SIZE + 3);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(fetchAgents).toHaveBeenCalledWith(1, PAGE_SIZE, 'score');
    });
  });

  it('navigates to the next page and shows page 2 agents', async () => {
    await renderWithTotal(PAGE_SIZE + 3);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(screen.getByText(`Agent ${PAGE_SIZE}`)).toBeInTheDocument();
    });
    expect(screen.queryByText('Agent 0')).not.toBeInTheDocument();
  });

  it('Next button is disabled on the last page', async () => {
    await renderWithTotal(PAGE_SIZE + 1);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Previous page' })).not.toBeDisabled();
  });

  it('navigates back with Prev after going to page 2', async () => {
    await renderWithTotal(PAGE_SIZE + 3);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(screen.getByText(`Agent ${PAGE_SIZE}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => {
      expect(screen.getByText('Agent 0')).toBeInTheDocument();
    });
  });

  it('calls fetchAgents with page=0 when sort changes', async () => {
    await renderWithTotal(PAGE_SIZE + 3);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(screen.getByText('2 / 2')).toBeInTheDocument();
    });

    jest.clearAllMocks();
    (fetchAgentStats as jest.Mock).mockResolvedValue(MOCK_STATS);
    setupMockFetchAgents(PAGE_SIZE + 3);

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort agents' }), {
      target: { value: 'payments' },
    });

    await waitFor(() => {
      expect(fetchAgents).toHaveBeenCalledWith(0, PAGE_SIZE, 'payments');
    });
    await waitFor(() => {
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('shows correct "Showing X–Y of Z" range on first page', async () => {
    const total = PAGE_SIZE + 5;
    await renderWithTotal(total);

    expect(
      screen.getByText(`Showing 1–${PAGE_SIZE} of ${total}`)
    ).toBeInTheDocument();
  });

  it('shows correct range on second page', async () => {
    const total = PAGE_SIZE + 5;
    await renderWithTotal(total);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(
        screen.getByText(`Showing ${PAGE_SIZE + 1}–${total} of ${total}`)
      ).toBeInTheDocument();
    });
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
