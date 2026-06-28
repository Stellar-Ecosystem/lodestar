     1|import React from 'react';
     2|import { render, screen, fireEvent, waitFor } from '@testing-library/react';
     3|import '@testing-library/jest-dom';
     4|import { SWRConfig } from 'swr';
     5|import RegistryPage from '../app/registry/page';
     6|import { PAGE_SIZE } from '../lib/pagination';
     7|import { fetchServices } from '../lib/contract';
     8|
     9|jest.mock('@/lib/contract', () => ({
    10|  fetchServices: jest.fn(),
    11|  submitReputation: jest.fn(),
    12|}));
    13|
    14|/** Wraps component in a fresh SWR provider so each test gets an isolated cache */
    15|function renderWithSWR(ui: React.ReactElement) {
    16|  return render(
    17|    <SWRConfig value={{ provider: () => new Map() }}>
    18|      {ui}
    19|    </SWRConfig>
    20|  );
    21|}
    22|
    23|function makeServices(count: number) {
    24|  return Array.from({ length: count }, (_, i) => ({
    25|    id: i + 1,
    26|    name: `Service ${i + 1}`,
    27|    description: `Description ${i + 1}`,
    28|    endpoint: `https://example.com/${i + 1}`,
    29|    price_usdc: `${(i + 1) * 0.5}`,
    30|    category: 'ai',
    31|    provider: `G${String(i + 1).padStart(55, 'A')}`,
    32|    reputation: i + 1,
    33|    active: true,
    34|    registered_at: Date.now(),
    35|  }));
    36|}
    37|
    38|describe('RegistryPage loading state', () => {
    39|  beforeEach(() => {
    40|    jest.clearAllMocks();
    42|  });
    43|
    44|  it('shows skeleton cards while loading', () => {
    45|    (fetchServices as jest.Mock).mockReturnValue(new Promise(() => {}));
    46|    renderWithSWR(<RegistryPage />);
    47|
    48|    expect(screen.getAllByTestId('service-card-skeleton')).toHaveLength(4);
    49|  });
    50|});
    51|
    52|// ── Empty state ────────────────────────────────────────────────────────────────
    53|
    54|describe('RegistryPage empty state', () => {
    55|  beforeEach(() => {
    56|    jest.clearAllMocks();
    58|  });
    59|
    60|  it('shows an empty-registry message when no services are returned', async () => {
    61|    (fetchServices as jest.Mock).mockResolvedValue([]);
    62|    renderWithSWR(<RegistryPage />);
    63|    await waitFor(() =>
    64|      expect(screen.getByText(/registry is empty/i)).toBeInTheDocument()
    65|    );
    66|  });
    67|});
    68|
    69|// ── Pagination: basic rendering ────────────────────────────────────────────────
    70|
    71|describe('RegistryPage pagination — basic rendering', () => {
    73|
    74|  it('renders only PAGE_SIZE cards when results exceed one page', async () => {
    75|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
    76|    renderWithSWR(<RegistryPage />);
    77|    await waitFor(() =>
    78|      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE)
    79|    );
    80|  });
    81|
    82|  it('renders all cards and hides pagination when results fit on one page', async () => {
    83|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE - 1));
    84|    renderWithSWR(<RegistryPage />);
    85|    await waitFor(() =>
    86|      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE - 1)
    87|    );
    88|    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
    89|  });
    90|
    91|  it('hides pagination when result count equals PAGE_SIZE exactly', async () => {
    92|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE));
    93|    renderWithSWR(<RegistryPage />);
    94|    await waitFor(() =>
    95|      expect(screen.getAllByText(/^Service \d+$/).length).toBe(PAGE_SIZE)
    96|    );
    97|    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
    98|  });
    99|
   100|  it('shows pagination controls when there is more than one page', async () => {
   101|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 1));
   102|    renderWithSWR(<RegistryPage />);
   103|    await waitFor(() =>
   104|      expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument()
   105|    );
   106|  });
   107|});
   108|
   109|// ── Pagination: Prev / Next buttons ────────────────────────────────────────────
   110|
   111|describe('RegistryPage pagination — Prev / Next buttons', () => {
   113|
   114|  it('disables the Previous button on the first page', async () => {
   115|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
   116|    renderWithSWR(<RegistryPage />);
   117|    await waitFor(() =>
   118|      expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled()
   119|    );
   120|  });
   121|
   122|  it('enables the Next button when more pages exist', async () => {
   123|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
   124|    renderWithSWR(<RegistryPage />);
   125|    await waitFor(() =>
   126|      expect(screen.getByRole('button', { name: /next page/i })).not.toBeDisabled()
   127|    );
   128|  });
   129|
   130|  it('advances to page 2 and disables Next on the last page', async () => {
   131|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 1));
   132|    renderWithSWR(<RegistryPage />);
   133|
   134|    const nextBtn = await screen.findByRole('button', { name: /next page/i });
   135|    fireEvent.click(nextBtn);
   136|
   137|    await waitFor(() =>
   138|      expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled()
   139|    );
   140|    expect(screen.getByRole('button', { name: /previous page/i })).not.toBeDisabled();
   141|  });
   142|
   143|  it('returns to page 1 when Previous is clicked from page 2', async () => {
   144|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
   145|    renderWithSWR(<RegistryPage />);
   146|
   147|    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
   148|    await waitFor(() =>
   149|      expect(screen.getByRole('button', { name: /previous page/i })).not.toBeDisabled()
   150|    );
   151|
   152|    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
   153|    await waitFor(() =>
   154|      expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled()
   155|    );
   156|  });
   157|});
   158|
   159|// ── Pagination: numbered page buttons ─────────────────────────────────────────
   160|
   161|describe('RegistryPage pagination — numbered page buttons', () => {
   163|
   164|  it('marks page 1 as current on initial load', async () => {
   165|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
   166|    renderWithSWR(<RegistryPage />);
   167|    const page1Btn = await screen.findByRole('button', { name: /^page 1$/i });
   168|    expect(page1Btn).toHaveAttribute('aria-current', 'page');
   169|  });
   170|
   171|  it('navigates directly to a page when its number button is clicked', async () => {
   172|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
   173|    renderWithSWR(<RegistryPage />);
   174|
   175|    fireEvent.click(await screen.findByRole('button', { name: /^page 2$/i }));
   176|
   177|    await waitFor(() =>
   178|      expect(screen.getByRole('button', { name: /^page 2$/i })).toHaveAttribute(
   179|        'aria-current',
   180|        'page'
   181|      )
   182|    );
   183|    expect(
   184|      screen.getByRole('button', { name: /^page 1$/i })
   185|    ).not.toHaveAttribute('aria-current', 'page');
   186|  });
   187|});
   188|
   189|// ── Pagination: "Showing X–Y of Z" label ──────────────────────────────────────
   190|
   191|describe('RegistryPage pagination — result range label', () => {
   193|
   194|  it('shows the correct range on page 1', async () => {
   195|    const total = PAGE_SIZE + 5;
   196|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
   197|    renderWithSWR(<RegistryPage />);
   198|    await waitFor(() =>
   199|      expect(
   200|        screen.getByText((_, el) => {
   201|          const t = el?.textContent ?? '';
   202|          return t.includes('1') && t.includes(`${PAGE_SIZE}`) && t.includes(`${total}`);
   203|        })
   204|      ).toBeInTheDocument()
   205|    );
   206|  });
   207|
   208|  it('shows the correct range on page 2', async () => {
   209|    const total = PAGE_SIZE * 2 + 3;
   210|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
   211|    renderWithSWR(<RegistryPage />);
   212|
   213|    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
   214|
   215|    await waitFor(() =>
   216|      expect(
   217|        screen.getByText((_, el) => {
   218|          const t = el?.textContent ?? '';
   219|          return (
   220|            t.includes(`${PAGE_SIZE + 1}`) &&
   221|            t.includes(`${PAGE_SIZE * 2}`) &&
   222|            t.includes(`${total}`)
   223|          );
   224|        })
   225|      ).toBeInTheDocument()
   226|    );
   227|  });
   228|
   229|  it('shows the correct remainder count on the last page', async () => {
   230|    const remainder = 3;
   231|    const total = PAGE_SIZE + remainder;
   232|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(total));
   233|    renderWithSWR(<RegistryPage />);
   234|
   235|    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
   236|
   237|    await waitFor(() =>
   238|      expect(screen.getAllByText(/^Service \d+$/).length).toBe(remainder)
   239|    );
   240|  });
   241|});
   242|
   243|// ── Pagination: reset on filter / sort / category change ──────────────────────
   244|
   245|describe('RegistryPage pagination — page resets on state change', () => {
   247|
   248|  async function goToPage2() {
   249|    fireEvent.click(await screen.findByRole('button', { name: /next page/i }));
   250|    await waitFor(() =>
   251|      expect(
   252|        screen.getByRole('button', { name: /^page 2$/i })
   253|      ).toHaveAttribute('aria-current', 'page')
   254|    );
   255|  }
   256|
   257|  it('resets to page 1 when the search query changes', async () => {
   258|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
   259|    renderWithSWR(<RegistryPage />);
   260|    await goToPage2();
   261|
   262|    fireEvent.change(
   263|      screen.getByPlaceholderText(/search by service name/i),
   264|      { target: { value: 'Service' } }
   265|    );
   266|
   267|    await waitFor(() =>
   268|      expect(
   269|        screen.getByRole('button', { name: /^page 1$/i })
   270|      ).toHaveAttribute('aria-current', 'page')
   271|    );
   272|  });
   273|
   274|  it('resets to page 1 when the sort order changes', async () => {
   275|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
   276|    renderWithSWR(<RegistryPage />);
   277|    await goToPage2();
   278|
   279|    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'reputation' } });
   280|
   281|    await waitFor(() =>
   282|      expect(
   283|        screen.getByRole('button', { name: /^page 1$/i })
   284|      ).toHaveAttribute('aria-current', 'page')
   285|    );
   286|  });
   287|
   288|  it('resets to page 1 when the active category changes', async () => {
   289|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE * 3));
   290|    renderWithSWR(<RegistryPage />);
   291|    await goToPage2();
   292|
   293|    // switch to a category — pagination either resets to 1 or disappears (no results)
   294|    fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));
   295|
   296|    await waitFor(() =>
   297|      expect(
   298|        screen.queryByRole('button', { name: /^page 2$/i })?.getAttribute('aria-current')
   299|      ).not.toBe('page')
   300|    );
   301|  });
   302|});
   303|
   304|// ── Pagination: empty search result ───────────────────────────────────────────
   305|
   306|describe('RegistryPage pagination — no results after filtering', () => {
   308|
   309|  it('shows no-results message and hides pagination when query matches nothing', async () => {
   310|    (fetchServices as jest.Mock).mockResolvedValue(makeServices(PAGE_SIZE + 5));
   311|    renderWithSWR(<RegistryPage />);
   312|    await screen.findByRole('button', { name: /next page/i });
   313|
   314|    fireEvent.change(
   315|      screen.getByPlaceholderText(/search by service name/i),
   316|      { target: { value: 'xyzzy-no-match-42' } }
   317|    );
   318|
   319|    await waitFor(() =>
   320|      expect(screen.getByText(/no services found/i)).toBeInTheDocument()
   321|    );
   322|    expect(
   323|      screen.queryByRole('navigation', { name: /pagination/i })
   324|    ).not.toBeInTheDocument();
   325|  });
   326|});
   327|