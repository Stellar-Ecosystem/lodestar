import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import ActivityFeed from '../components/ActivityFeed';

global.fetch = jest.fn();

const mockActivities = Array.from({ length: 25 }).map((_, i) => ({
  agent: `Agent${i}`,
  service: `Service${i}`,
  amount: (i + 1).toString(),
  timestamp: new Date().toISOString(),
  txHash: `hash${i}`
}));

describe('ActivityFeed Pagination', () => {
  it('has no critical or serious accessibility violations', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ activity: mockActivities })
    });

    const { container } = render(<ActivityFeed />);

    await waitFor(() => {
      expect(screen.getAllByText(/Agent/).length).toBe(10);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    expect(results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toHaveLength(0);
  });


  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders initial loading state and then 10 items initially', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ activity: mockActivities })
    });

    render(<ActivityFeed />);

    expect(screen.getByTestId('activity-feed-loading')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByTestId('activity-feed-loading')).not.toBeInTheDocument();
    });

    // Should have 10 items rendered
    const entries = screen.getAllByText(/Agent/);
    expect(entries.length).toBe(10);
    expect(screen.getByRole('button', { name: 'Show more activity entries' })).toBeInTheDocument();
  });

  it('increments by 10 when clicking Show More and hides button at the end', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ activity: mockActivities })
    });

    render(<ActivityFeed />);

    await waitFor(() => {
      expect(screen.getAllByText(/Agent/).length).toBe(10);
    });

    const button = screen.getByRole('button', { name: 'Show more activity entries' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getAllByText(/Agent/).length).toBe(20);
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getAllByText(/Agent/).length).toBe(25);
    });

    // Button should be hidden
    expect(screen.queryByRole('button', { name: 'Show more activity entries' })).not.toBeInTheDocument();
  });

  it('does not show button if less than 10 items', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ activity: mockActivities.slice(0, 5) })
    });

    render(<ActivityFeed />);

    await waitFor(() => {
      expect(screen.getAllByText(/Agent/).length).toBe(5);
    });

    expect(screen.queryByRole('button', { name: 'Show more activity entries' })).not.toBeInTheDocument();
  });

  it('handles empty feed correctly', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ activity: [] })
    });

    render(<ActivityFeed />);

    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeInTheDocument();
    });
  });

  it('logs structured error on fetch failure and shows error state with retry', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network disconnected'));

    render(<ActivityFeed />);

    await waitFor(() => {
      expect(console.error).toHaveBeenCalled();
      const logArg = (console.error as jest.Mock).mock.calls[0][0];
      expect(logArg).toContain('activity_feed_fetch_failed');
    });

    // Error state should be visible
    expect(screen.getByText('Failed to load activity')).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toBeInTheDocument();

    // Mock success for retry
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ activity: mockActivities.slice(0, 1) })
    });

    fireEvent.click(retryButton);

    // Should go back to loading state
    expect(screen.getByTestId('activity-feed-loading')).toBeInTheDocument();

    // Then show the item
    await waitFor(() => {
      expect(screen.getByText(/Agent/)).toBeInTheDocument();
      expect(screen.queryByText('Failed to load activity')).not.toBeInTheDocument();
    });
  });
});
