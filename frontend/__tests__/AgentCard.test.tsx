import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentCard from '../components/AgentCard';
import type { AgentEntry } from '@/lib/types';

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  );
  MockLink.displayName = 'Link';
  return MockLink;
});

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    address: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    name: 'Agent Alpha',
    description: 'Handles demo requests',
    owner: 'GOWNER',
    score: 820,
    total_payments: '1234',
    successful_payments: '1111',
    failed_payments: '123',
    total_volume_stroops: '10000000',
    registered_at: '12345',
    last_active: '12350',
    active: true,
    flagged: false,
    flag_reason: '',
    ...overrides,
  };
}

describe('AgentCard', () => {
  it('renders the default active agent state and supports user interaction with profile links', async () => {
    const user = userEvent.setup();
    const agent = makeAgent({
      total_payments: '100',
      successful_payments: '90',
      score: 900,
    });

    render(<AgentCard agent={agent} />);

    expect(screen.getByRole('link', { name: 'Agent Alpha' })).toHaveAttribute(
      'href',
      `/agents/${agent.address}`
    );
    expect(screen.getByRole('link', { name: /GABC12\.\.\.7890/ })).toHaveAttribute(
      'href',
      `https://stellar.expert/explorer/testnet/account/${agent.address}`
    );
    expect(screen.getByText('Handles demo requests')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Ledger #12,345')).toBeInTheDocument();

    const viewProfileLink = screen.getByRole('link', { name: 'View profile →' });
    await user.click(viewProfileLink);
    expect(viewProfileLink).toHaveAttribute('href', `/agents/${agent.address}`);
  });

  it('applies the flagged styling and status branch when an agent is flagged', () => {
    const { container } = render(<AgentCard agent={makeAgent({ flagged: true, active: true })} />);

    expect(container.firstChild).toHaveClass('border-error/40');
    expect(screen.getByText('Flagged')).toBeInTheDocument();
    expect(screen.getByText('Flagged')).toHaveClass('text-error');
  });

  it('shows the inactive status branch when an agent is not active', () => {
    render(<AgentCard agent={makeAgent({ active: false, flagged: false, total_payments: '0' })} />);

    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toHaveClass('text-error');
  });

  it('renders a dash for the success rate when there are no payments', () => {
    render(<AgentCard agent={makeAgent({ total_payments: '0', successful_payments: '0' })} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('—')).toHaveClass('text-primary');
  });

  it('renders the neutral success-state styling when the success rate is below 90%', () => {
    render(<AgentCard agent={makeAgent({ total_payments: '100', successful_payments: '89' })} />);

    expect(screen.getByText('89%')).toHaveClass('text-primary');
  });

  it('renders the success-state styling when the success rate is 90% or higher', () => {
    render(<AgentCard agent={makeAgent({ total_payments: '100', successful_payments: '90' })} />);

    expect(screen.getByText('90%')).toHaveClass('text-success');
  });

  it('allows the explorer link to be used with a user click and keeps the expected external attributes', async () => {
    const user = userEvent.setup();
    const agent = makeAgent();

    render(<AgentCard agent={agent} />);

    const explorerLink = screen.getByRole('link', { name: /GABC12\.\.\.7890/ });
    expect(explorerLink).toHaveAttribute('target', '_blank');
    expect(explorerLink).toHaveAttribute('rel', 'noopener noreferrer');

    await user.click(explorerLink);
    expect(explorerLink).toHaveAttribute('href', `https://stellar.expert/explorer/testnet/account/${agent.address}`);
  });
});
