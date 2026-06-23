import type { ServiceEntry } from '@/lib/types';

// sortServices moved to lib/sort.ts

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