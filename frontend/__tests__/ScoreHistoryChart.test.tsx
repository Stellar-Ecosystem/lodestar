import React from 'react';
import { render, screen } from '@testing-library/react';
import { ScoreHistoryChart } from '../components/ScoreHistoryChart';
import type { ScoreEvent } from '../components/ScoreHistoryChart';

describe('ScoreHistoryChart', () => {
  // ── Synthetic data path (scoreHistory omitted / null) ─────────────────────

  it('renders nothing when there are no payments and no scoreHistory', () => {
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

  it('renders the synthetic sparkline with an explicit "estimated" label', () => {
    render(
      <ScoreHistoryChart
        currentScore={520}
        totalPayments={3}
        successfulPayments={2}
        failedPayments={1}
      />
    );

    // The label must use "estimated", not the old "approx"
    expect(screen.getByText('Score History (estimated)')).toBeInTheDocument();

    const polyline = document.querySelector('polyline');
    expect(polyline).toBeInTheDocument();

    const circle = document.querySelector('circle');
    expect(circle).toBeInTheDocument();
  });

  it('carries a tooltip explaining the synthetic nature of the data', () => {
    render(
      <ScoreHistoryChart
        currentScore={520}
        totalPayments={3}
        successfulPayments={2}
        failedPayments={1}
      />
    );

    const label = screen.getByText('Score History (estimated)');
    expect(label.getAttribute('title')).toMatch(/reconstructed from payment counts/i);
  });

  it('renders the synthetic line with reduced opacity', () => {
    render(
      <ScoreHistoryChart
        currentScore={520}
        totalPayments={3}
        successfulPayments={2}
        failedPayments={1}
      />
    );

    const polyline = document.querySelector('polyline');
    // SVG className is an SVGAnimatedString in jsdom — use getAttribute instead
    expect(polyline?.getAttribute('class')).toContain('opacity-40');
  });

  it('clamps synthetic score projections to [0, 1000]', () => {
    // currentScore=0 and 2 successful payments means reconstructed start is negative
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

    // No point coordinate should be outside the SVG height
    const points = polyline!.getAttribute('points')!.split(' ');
    for (const point of points) {
      const [, y] = point.split(',').map(Number);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(30);
    }
  });

  // ── Real event data path (scoreHistory provided) ─────────────────────────

  it('renders the empty state with "No history yet" when scoreHistory is an empty array', () => {
    render(
      <ScoreHistoryChart
        currentScore={100}
        totalPayments={0}
        successfulPayments={0}
        failedPayments={0}
        scoreHistory={[]}
      />
    );

    expect(screen.getByText('Score History')).toBeInTheDocument();
    expect(screen.getByText('No history yet')).toBeInTheDocument();

    // No sparkline should be drawn
    expect(document.querySelector('polyline')).toBeNull();
  });

  it('renders a clean chart without "estimated" when scoreHistory has events', () => {
    const events: ScoreEvent[] = [
      { timestamp: 1700000000, score: 100 },
      { timestamp: 1700001000, score: 110 },
      { timestamp: 1700002000, score: 120 },
    ];

    render(
      <ScoreHistoryChart
        currentScore={120}
        totalPayments={2}
        successfulPayments={2}
        failedPayments={0}
        scoreHistory={events}
      />
    );

    // Unambiguous "Score History" label, no "estimated" qualifier
    expect(screen.getByText('Score History')).toBeInTheDocument();
    expect(screen.queryByText('Score History (estimated)')).toBeNull();

    const polyline = document.querySelector('polyline');
    expect(polyline).toBeInTheDocument();

    // Real-data line must be fully opaque (not the 40% opacity used for synthetic)
    // SVG className is an SVGAnimatedString in jsdom — use getAttribute instead
    expect(polyline?.getAttribute('class')).not.toContain('opacity-40');
    expect(polyline?.getAttribute('class')).toContain('opacity-80');

    const circle = document.querySelector('circle');
    expect(circle).toBeInTheDocument();
  });

  it('places the terminal dot at the correct y coordinate for real events', () => {
    const events: ScoreEvent[] = [
      { timestamp: 1700000000, score: 500 },
      { timestamp: 1700001000, score: 1000 },
    ];

    render(
      <ScoreHistoryChart
        currentScore={1000}
        totalPayments={1}
        successfulPayments={1}
        failedPayments={0}
        scoreHistory={events}
      />
    );

    const circle = document.querySelector('circle');
    // score=1000, HEIGHT=30 → y = 30 - (1000/1000)*30 = 0
    expect(circle?.getAttribute('cy')).toBe('0');
  });
});
