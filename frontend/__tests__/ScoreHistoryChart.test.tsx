import React from 'react';
import { render, screen } from '@testing-library/react';
import { ScoreHistoryChart } from '../components/ScoreHistoryChart';

describe('ScoreHistoryChart', () => {
  it('renders nothing when there are no payments', () => {
    const { container } = render(
      <ScoreHistoryChart
        currentScore={500}
        totalPayments={0}
        successfulPayments={0}
        failedPayments={0}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a sparkline when there are payments', () => {
    render(
      <ScoreHistoryChart
        currentScore={520}
        totalPayments={3}
        successfulPayments={2}
        failedPayments={1}
      />
    );
    expect(screen.getByText('Score History (approx)')).toBeInTheDocument();
    
    // Check for polyline and circle elements
    const polyline = document.querySelector('polyline');
    expect(polyline).toBeInTheDocument();
    
    const circle = document.querySelector('circle');
    expect(circle).toBeInTheDocument();
  });

  it('handles negative score projections by clamping to 0', () => {
    render(
      <ScoreHistoryChart
        currentScore={0}
        totalPayments={2}
        successfulPayments={2}
        failedPayments={0}
      />
    );
    
    const polyline = document.querySelector('polyline');
    expect(polyline).toBeInTheDocument();
    // we just ensure it doesn't crash and renders the chart
    expect(screen.getByText('Score History (approx)')).toBeInTheDocument();
  });
});
