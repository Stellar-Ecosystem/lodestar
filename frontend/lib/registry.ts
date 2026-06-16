import type { ServiceEntry, SortOption } from '@/lib/types';

export function sortServices(
  services: ServiceEntry[],
  sort: SortOption,
): ServiceEntry[] {
  return [...services].sort((a, b) => {
    if (sort === 'reputation') return b.reputation - a.reputation;
    if (sort === 'price') return parseFloat(a.price_usdc) - parseFloat(b.price_usdc);
    return b.registered_at - a.registered_at;
  });
}

export function filterServices(
  services: ServiceEntry[],
  query: string,
): ServiceEntry[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return services;
  }

  return services.filter((service) => {
    const haystacks = [service.name, service.description];
    return haystacks.some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    );
  });
}
