import React from 'react';
import { render, screen } from '@testing-library/react';
import RegistryPage from '../app/registry/page';

jest.mock('../lib/contract', () => ({
  fetchServices: jest.fn(() => Promise.resolve([])),
}));

jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
    mutate: jest.fn(),
  })),
}), { virtual: true });

describe('RegistryPage category filters', () => {
  it('renders the shared category icons in filter chips', () => {
    const { container } = render(<RegistryPage />);

    expect(screen.getByRole('button', { name: 'Weather' })).toBeInTheDocument();
    expect(container.querySelector('[data-category-icon="weather"]')).toBeInTheDocument();
  });
});
