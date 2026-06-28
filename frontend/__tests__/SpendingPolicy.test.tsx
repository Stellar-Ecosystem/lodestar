import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SpendingPolicyDisplay from '../components/SpendingPolicy';
import type { SpendingPolicy } from '../lib/types';

const mockPolicy: SpendingPolicy = {
  agent_address: 'GTESTADDRESS',
  max_per_tx_stroops: '1000000',   // 0.1 USDC
  max_per_day_stroops: '10000000', // 1 USDC
  allowed_categories: ['search', 'weather'],
  min_score_to_earn: 100,
  daily_spent_stroops: '500000',   // 0.05 USDC
  last_reset_ledger: '500000',
};

describe('SpendingPolicyDisplay', () => {
  it('renders policy details in read mode', () => {
    render(<SpendingPolicyDisplay policy={mockPolicy} />);
    expect(screen.getByText('Spending Policy')).toBeInTheDocument();
    expect(screen.getByText('$0 USDC')).toBeInTheDocument();   // max_per_tx: 1000000 / 10000000 = 0
    expect(screen.getByText('$1 USDC')).toBeInTheDocument();   // max_per_day
    expect(screen.getByText('100')).toBeInTheDocument();        // min_score_to_earn
    expect(screen.getByText('search, weather')).toBeInTheDocument();
  });

  it('does not show Edit button when wallet is not the owner', () => {
    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GDIF"
        agentOwner="GOTHER"
      />,
    );
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('shows Edit button when wallet matches owner', () => {
    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GOWNER"
        agentOwner="GOWNER"
      />,
    );
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('enters edit mode and shows form inputs', async () => {
    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GOWNER"
        agentOwner="GOWNER"
      />,
    );

    fireEvent.click(screen.getByText('Edit'));

    expect(screen.getByText('Save changes')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();

    // Category buttons should be visible
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('weather')).toBeInTheDocument();
    expect(screen.getByText('finance')).toBeInTheDocument();
  });

  it('cancels edit mode and returns to read mode', async () => {
    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GOWNER"
        agentOwner="GOWNER"
      />,
    );

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Save changes')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('calls onUpdate with correct params on submit', async () => {
    const onUpdate = jest.fn().mockResolvedValue(undefined);

    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GOWNER"
        agentOwner="GOWNER"
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          maxPerTxStroops: expect.any(String),
          maxPerDayStroops: expect.any(String),
          allowedCategories: ['search', 'weather'],
          minScoreToEarn: 100,
        }),
      );
    });
  });

  it('toggles category selection in edit mode', () => {
    render(
      <SpendingPolicyDisplay
        policy={mockPolicy}
        walletAddress="GOWNER"
        agentOwner="GOWNER"
      />,
    );

    fireEvent.click(screen.getByText('Edit'));

    // search and weather are pre-selected (from policy), click to deselect search
    const searchBtn = screen.getByText('search');
    fireEvent.click(searchBtn);

    // finance is not selected, click to select it
    const financeBtn = screen.getByText('finance');
    fireEvent.click(financeBtn);

    // Now search should be deselected and finance selected
    // Category count should still be 2
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});
