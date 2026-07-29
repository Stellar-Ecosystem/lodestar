import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RootError from '../app/error';
import GlobalError from '../app/global-error';
import RegistryError from '../app/registry/error';
import AgentsError from '../app/agents/error';
import ServicesError from '../app/services/error';

describe('Error Boundaries', () => {
  const mockError = new Error('Test contract read error');
  const mockReset = jest.fn();
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('Root Error Boundary (app/error.tsx)', () => {
    it('renders branded message and diagnostic details', () => {
      render(<RootError error={mockError} reset={mockReset} />);

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('Application Error')).toBeInTheDocument();
      expect(screen.getByText(/Test contract read error/i)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Lodestar Root Error Boundary]:',
        mockError
      );
    });

    it('triggers reset action on clicking Try again', () => {
      render(<RootError error={mockError} reset={mockReset} />);

      const retryBtn = screen.getByRole('button', { name: /try again/i });
      fireEvent.click(retryBtn);

      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('Global Error Boundary (app/global-error.tsx)', () => {
    it('renders branded fatal error message and reset button', () => {
      render(<GlobalError error={mockError} reset={mockReset} />);

      expect(screen.getByText('Application Shell Error')).toBeInTheDocument();
      expect(screen.getByText('Fatal Error')).toBeInTheDocument();
      expect(screen.getByText(/Test contract read error/i)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Lodestar Global Error Boundary]:',
        mockError
      );
    });

    it('triggers reset on clicking Reload Application', () => {
      render(<GlobalError error={mockError} reset={mockReset} />);

      const reloadBtn = screen.getByRole('button', { name: /reload application/i });
      fireEvent.click(reloadBtn);

      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('Registry Error Boundary (app/registry/error.tsx)', () => {
    it('renders registry error message and diagnostic details', () => {
      render(<RegistryError error={mockError} reset={mockReset} />);

      expect(screen.getByText('Unable to load Service Registry')).toBeInTheDocument();
      expect(screen.getByText('Registry Read Error')).toBeInTheDocument();
      expect(screen.getByText(/Test contract read error/i)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Lodestar Registry Error Boundary]:',
        mockError
      );
    });

    it('triggers reset on clicking Retry Registry Load', () => {
      render(<RegistryError error={mockError} reset={mockReset} />);

      const retryBtn = screen.getByRole('button', { name: /retry registry load/i });
      fireEvent.click(retryBtn);

      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('Agents Error Boundary (app/agents/error.tsx)', () => {
    it('renders agents error message and diagnostic details', () => {
      render(<AgentsError error={mockError} reset={mockReset} />);

      expect(screen.getByText('Unable to load Agent Scores')).toBeInTheDocument();
      expect(screen.getByText('Agent Scores Error')).toBeInTheDocument();
      expect(screen.getByText(/Test contract read error/i)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Lodestar Agents Error Boundary]:',
        mockError
      );
    });

    it('triggers reset on clicking Retry Loading Scores', () => {
      render(<AgentsError error={mockError} reset={mockReset} />);

      const retryBtn = screen.getByRole('button', { name: /retry loading scores/i });
      fireEvent.click(retryBtn);

      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('Services Error Boundary (app/services/error.tsx)', () => {
    it('renders services error message and diagnostic details', () => {
      render(<ServicesError error={mockError} reset={mockReset} />);

      expect(screen.getByText('Unable to load Service Details')).toBeInTheDocument();
      expect(screen.getByText('Service Error')).toBeInTheDocument();
      expect(screen.getByText(/Test contract read error/i)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Lodestar Services Error Boundary]:',
        mockError
      );
    });

    it('triggers reset on clicking Retry Loading Service', () => {
      render(<ServicesError error={mockError} reset={mockReset} />);

      const retryBtn = screen.getByRole('button', { name: /retry loading service/i });
      fireEvent.click(retryBtn);

      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });
});
