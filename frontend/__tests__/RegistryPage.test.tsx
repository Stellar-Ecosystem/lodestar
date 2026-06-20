import React from 'react';
import { render } from '@testing-library/react';
import { SWRConfig } from 'swr';
import RegistryPage from '../app/registry/page';
import { fetchServices } from '../lib/contract';

jest.mock('../lib/contract', () => ({
  fetchServices: jest.fn(),
}));

// Fresh SWR cache per render so cached data never leaks between tests.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RegistryPage />
    </SWRConfig>
  );
}

describe('RegistryPage loading state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows skeleton cards while loading', () => {
    (fetchServices as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { getAllByTestId } = renderPage();
    expect(getAllByTestId('service-card-skeleton')).toHaveLength(4);
  });
});
