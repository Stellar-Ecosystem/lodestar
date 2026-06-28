import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RegistryPage from '../app/registry/page';
import { PAGE_SIZE } from '../lib/pagination';
import { fetchServices } from '../lib/contract';

jest.mock('@/lib/contract', () => ({
  fetchServices: jest.fn(),
  submitReputation: jest.fn(),
}));

function makeServices(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Service ${i + 1}`,
    description: `Description ${i + 1}`,
    endpoint: `https://example.com/${i + 1}`,
    price_usdc: `${(i + 1) * 0.5}`,
    category: 'API',
    provider: `G${String(i + 1).padStart(55, 'A')}`,
    reputation: i + 1,
    active: true,
    registered_at: Date.now(),
  }));
}

describe('RegistryPage loading state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows skeleton cards while loading', () => {
    (fetchServices as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(<RegistryPage />);

    expect(screen.getAllByTestId('service-card-skeleton')).toHaveLength(4);
  });
});

// ── Empty state ────────────────────────────────────────────────────────────────

describe('RegistryPage empty state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows an empty-registry message when no services are returned', async () => {
    (fetchServices as jest.Mock).mockResolvedValue([]);
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getByText(/registry is empty/i)).toBeInTheDocument()
    );
  });
});

// ── Pagination: basic rendering ────────────────────────────────────────────────

describe('RegistryPage pagination — basic rendering', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders only PAGE_SIZE cards when results exceed one page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE)
    );
  });

  it('renders all cards and hides pagination when results fit on one page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE - 1));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE - 1)
    );
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });

  it('hides pagination when result count equals PAGE_SIZE exactly', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE)
    );
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });

  it('shows pagination controls when there is more than one page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 1));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument()
    );
  });
});

// ── Pagination: Prev / Next buttons ────────────────────────────────────────────

describe('RegistryPage pagination — Prev / Next buttons', () => {
  beforeEach(() => jest.clearAllMocks());

  it('disables the Previous button on the first page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled()
    );
  });

  it('enables the Next button when more pages exist', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /next page/i })).not.toBeDisabled()
    );
  });

  it('advances to page 2 and disables Next on the last page', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 1));
    render(<RegistryPage />);

    const nextBtn = await screen.findByRole('button', { name: /next page/i });
    fireEvent.click(nextBtn);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled()
    );
    expect(screen.getByRole('button', { name: /previous page/i })).not.toBeDisabled();
  });

  it('returns to page 1 when Previous is clicked from page 2', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);

    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /previous page/i })).not.toBeDisabled()
    );

    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled()
    );
  });
});

// ── Pagination: numbered page buttons ─────────────────────────────────────────

describe('RegistryPage pagination — numbered page buttons', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks page 1 as current on initial load', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);
    const page1Btn = await screen.findByRole('button', { name: /^page 1$/i });
    expect(page1Btn).toHaveAttribute('aria-current', 'page');
  });

  it('navigates directly to a page when its number button is clicked', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
    render(<RegistryPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^page 2$/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^page 2$/i })).toHaveAttribute(
        'aria-current',
        'page'
      )
    );
    expect(
      screen.getByRole('button', { name: /^page 1$/i })
    ).not.toHaveAttribute('aria-current', 'page');
  });
});

// ── Pagination: "Showing X–Y of Z" label ──────────────────────────────────────

describe('RegistryPage pagination — result range label', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the correct range on page 1', async () => {
    const total = PAGE_SIZE + 5;
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
    render(<RegistryPage />);
    await waitFor(() =>
      expect(
        screen.getByText((_, el) => {
          const t = el?.textContent ?? '';
          return t.includes('1') && t.includes(`${PAGE_SIZE}`) && t.includes(`${total}`);
        })
      ).toBeInTheDocument()
    );
  });

  it('shows the correct range on page 2', async () => {
    const total = PAGE_SIZE * 2 + 3;
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
    render(<RegistryPage />);

    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));

    await waitFor(() =>
      expect(
        screen.getByText((_, el) => {
          const t = el?.textContent ?? '';
          return (
            t.includes(`${PAGE_SIZE + 1}`) &&
            t.includes(`${PAGE_SIZE * 2}`) &&
            t.includes(`${total}`)
          );
        })
      ).toBeInTheDocument()
    );
  });

  it('shows the correct remainder count on the last page', async () => {
    const remainder = 3;
    const total = PAGE_SIZE + remainder;
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
    render(<RegistryPage />);

    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));

    await waitFor(() =>
      expect(screen.getAllByText(/^Service \d+$/).length).toBe(remainder)
    );
  });
});

// ── Pagination: reset on filter / sort / category change ──────────────────────

describe('RegistryPage pagination — page resets on state change', () => {
  beforeEach(() => jest.clearAllMocks());

  async function goToPage2() {
    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^page 2$/i })
      ).toHaveAttribute('aria-current', 'page')
    );
  }

  it('resets to page 1 when the search query changes', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
    render(<RegistryPage />);
    await goToPage2();

    fireEvent.change(
      screen.getByPlaceholderText(/search by service name/i),
      { target: { value: 'Service' } }
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^page 1$/i })
      ).toHaveAttribute('aria-current', 'page')
    );
  });

  it('resets to page 1 when the sort order changes', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
    render(<RegistryPage />);
    await goToPage2();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'reputation' } });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^page 1$/i })
      ).toHaveAttribute('aria-current', 'page')
    );
  });

  it('resets to page 1 when the active category changes', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
    render(<RegistryPage />);
    await goToPage2();

    // switch to a category — pagination either resets to 1 or disappears (no results)
    fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^page 2$/i })?.getAttribute('aria-current')
      ).not.toBe('page')
    );
  });
});

// ── Pagination: empty search result ───────────────────────────────────────────

describe('RegistryPage pagination — no results after filtering', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows no-results message and hides pagination when query matches nothing', async () => {
    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    render(<RegistryPage />);
    await screen.findByRole('button', { name: /next page/i });

    fireEvent.change(
      screen.getByPlaceholderText(/search by service name/i),
      { target: { value: 'xyzzy-no-match-42' } }
    );

    await waitFor(() =>
      expect(screen.getByText(/no services found/i)).toBeInTheDocument()
    );
    expect(
      screen.queryByRole('navigation', { name: /pagination/i })
    ).not.toBeInTheDocument();
  });
});
