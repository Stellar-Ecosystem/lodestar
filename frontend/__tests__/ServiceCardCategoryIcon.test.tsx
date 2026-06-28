import React from 'react';
import { render, screen } from '@testing-library/react';
import ServiceCard from '../components/ServiceCard';
import { CATEGORY_META } from '../lib/categoryMeta';

jest.mock('../lib/contract', () => ({
  submitReputation: jest.fn(),
}));

describe('ServiceCard category badge', () => {
  it('renders the shared category icon and label', () => {
    const { container } = render(
      <ServiceCard
        service={{
          id: 1,
          name: 'Forecast API',
          description: 'Weather data for agents',
          endpoint: 'https://example.com/weather',
          price_usdc: '1.00',
          category: 'weather',
          provider: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF',
          reputation: 2,
          active: true,
          registered_at: 123456,
        }}
      />
    );

    expect(screen.getByText(CATEGORY_META.weather.label)).toBeInTheDocument();
    expect(container.querySelector('[data-category-icon="weather"]')).toBeInTheDocument();
  });
});
