import React from 'react';
import { render, screen } from '@testing-library/react';
import Navbar from '../components/Navbar';

let mockPathname = '/';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = 'Link';
  return MockLink;
});

jest.mock('../components/WalletConnect', () => {
  const MockWalletConnect = () => <div data-testid="wallet-connect" />;
  MockWalletConnect.displayName = 'WalletConnect';
  return MockWalletConnect;
});

function setPathname(path: string) {
  mockPathname = path;
}

describe('Navbar active-link highlighting', () => {
  it('marks the link for the current route as active', () => {
    setPathname('/registry');
    render(<Navbar />);

    const registry = screen.getByRole('link', { name: 'Registry' });
    expect(registry).toHaveAttribute('aria-current', 'page');
    expect(registry).toHaveClass('font-medium');

    const agents = screen.getByRole('link', { name: 'Agents' });
    expect(agents).not.toHaveAttribute('aria-current');
  });

  it('highlights a parent link on nested routes via prefix match', () => {
    setPathname('/agents/GABC123');
    render(<Navbar />);

    const agents = screen.getByRole('link', { name: 'Agents' });
    expect(agents).toHaveAttribute('aria-current', 'page');
  });

  it('does not highlight /register on the /registry route (no false prefix match)', () => {
    setPathname('/registry');
    render(<Navbar />);

    const register = screen.getByRole('link', { name: 'Register' });
    expect(register).not.toHaveAttribute('aria-current');
  });

  it('does not highlight any nav link on the home route', () => {
    setPathname('/');
    render(<Navbar />);

    for (const label of ['Registry', 'Agents', 'Register', 'Demo']) {
      expect(
        screen.getByRole('link', { name: label })
      ).not.toHaveAttribute('aria-current');
    }
  });
});
