declare module 'jest-axe' {
  import type { RunOptions, AxeResults } from 'axe-core';

  export function axe(
    html: Element | string,
    options?: RunOptions
  ): Promise<AxeResults>;

  export function toHaveNoViolations(results: AxeResults): jest.CustomMatcherResult;
}
