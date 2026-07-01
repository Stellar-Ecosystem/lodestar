import React from 'react';
import { render, screen } from '@testing-library/react';
import ScoreBadge from '../components/ScoreBadge';

describe('ScoreBadge Aria-Live Announcements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders score normally without announcement on first render', () => {
    render(<ScoreBadge score={500} />);
    
    // Score is visible
    expect(screen.getByText('500')).toBeInTheDocument();
    
    // Live region is in the document but empty
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
    expect(liveRegion).toBeEmptyDOMElement();
  });

  it('triggers announcement when score increases', () => {
    const { rerender } = render(<ScoreBadge score={500} />);
    
    // Live region should be empty initially
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    rerender(<ScoreBadge score={600} />);
    
    // Live region should have updated announcement
    expect(screen.getByRole('status')).toHaveTextContent('Score increased to 600');
  });

  it('triggers announcement when score decreases', () => {
    const { rerender } = render(<ScoreBadge score={500} />);
    
    rerender(<ScoreBadge score={450} />);
    
    // Live region should have updated announcement
    expect(screen.getByRole('status')).toHaveTextContent('Agent score updated to 450');
  });

  it('does not trigger announcement when score remains unchanged', () => {
    const { rerender } = render(<ScoreBadge score={500} />);
    
    rerender(<ScoreBadge score={500} />);
    
    // Live region should remain empty
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('handles invalid score safely and logs error', () => {
    // @ts-ignore - purposefully passing invalid score
    render(<ScoreBadge score={NaN} />);
    
    expect(console.error).toHaveBeenCalled();
    const calls = (console.error as jest.Mock).mock.calls;
    const scoreCall = calls.find(([msg]) =>
      typeof msg === 'string' && msg.includes('score_announcement_failed')
    );
    expect(scoreCall).toBeDefined();
  });
});
