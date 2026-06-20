import React from 'react';
import { render } from '@testing-library/react';
import ServiceCardSkeleton from '../components/ServiceCardSkeleton';
import AgentCardSkeleton from '../components/AgentCardSkeleton';

describe('ServiceCardSkeleton', () => {
  it('renders a card with animate-pulse', () => {
    const { container } = render(<ServiceCardSkeleton />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveClass('card', 'animate-pulse');
  });

  it('renders the endpoint bar placeholder', () => {
    const { getByTestId } = render(<ServiceCardSkeleton />);
    expect(getByTestId('skeleton-endpoint')).toBeInTheDocument();
  });

  it('renders the button placeholder', () => {
    const { getByTestId } = render(<ServiceCardSkeleton />);
    expect(getByTestId('skeleton-button')).toBeInTheDocument();
  });
});

describe('AgentCardSkeleton', () => {
  it('renders a card with animate-pulse', () => {
    const { container } = render(<AgentCardSkeleton />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveClass('card', 'animate-pulse');
  });

  it('renders three stat placeholders', () => {
    const { getByTestId } = render(<AgentCardSkeleton />);
    const statsGrid = getByTestId('skeleton-stats');
    expect(statsGrid.children).toHaveLength(3);
  });

  it('renders a score badge placeholder', () => {
    const { getByTestId } = render(<AgentCardSkeleton />);
    expect(getByTestId('skeleton-badge')).toBeInTheDocument();
  });
});
