import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { LoginPage } from '@client/pages/login';
import { renderPage } from './render';

describe('LoginPage — Bitbucket stacked CTA (D-22/D-23/D-24/D-25/D-35)', () => {
  it('renders both a GitHub CTA and a Bitbucket CTA with correct hrefs and labels', () => {
    renderPage(<LoginPage />, { route: '/login' });

    const githubLink = screen.getByRole('link', { name: /Sign in with GitHub/i });
    const bitbucketLink = screen.getByRole('link', { name: /Sign in with Bitbucket/i });

    expect(githubLink).toHaveAttribute('href', '/auth/github');
    expect(bitbucketLink).toHaveAttribute('href', '/auth/bitbucket');
  });

  it('renders a brand mark svg inside each CTA (2 total)', () => {
    renderPage(<LoginPage />, { route: '/login' });

    const githubLink = screen.getByRole('link', { name: /Sign in with GitHub/i });
    const bitbucketLink = screen.getByRole('link', { name: /Sign in with Bitbucket/i });

    const githubMarks = githubLink.querySelectorAll('svg[aria-hidden="true"]');
    const bitbucketMarks = bitbucketLink.querySelectorAll('svg[aria-hidden="true"]');

    expect(githubMarks).toHaveLength(1);
    expect(bitbucketMarks).toHaveLength(1);
  });

  it('renders the provider-neutral heading and sub copy', () => {
    renderPage(<LoginPage />, { route: '/login' });

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Sign in with your approved GitHub or Bitbucket account to access the PR review dashboard.',
      ),
    ).toBeInTheDocument();
  });

  it('renders the provider-neutral footer note', () => {
    renderPage(<LoginPage />, { route: '/login' });

    expect(screen.getByText('Only authorized users can access this instance.')).toBeInTheDocument();
  });

  it('renders the invalid_grant error message', () => {
    renderPage(<LoginPage />, { route: '/login?error=invalid_grant' });

    expect(
      screen.getByText(
        'Bitbucket rejected the sign-in code (it may have expired or been used already). Please try again.',
      ),
    ).toBeInTheDocument();
  });

  it('renders the bitbucket_not_allowed error message', () => {
    renderPage(<LoginPage />, { route: '/login?error=bitbucket_not_allowed' });

    expect(
      screen.getByText(
        'This Bitbucket account is not allowed to access the OpenCodra dashboard. Ask an operator to add your Bitbucket account_id to the allow-list.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the 5 existing GitHub-specific error reasons byte-identical', () => {
    const cases: Array<[string, string]> = [
      ['not_allowed', 'This GitHub account is not allowed to access the OpenCodra dashboard.'],
      ['access_denied', 'GitHub sign-in was cancelled before authorization completed.'],
      ['invalid_state', 'Your sign-in session expired. Please try signing in with GitHub again.'],
      ['invalid_callback', 'GitHub did not return a valid callback. Please try again.'],
      ['oauth_failed', 'GitHub sign-in failed while completing the OAuth flow.'],
    ];

    for (const [reason, message] of cases) {
      const { unmount } = renderPage(<LoginPage />, { route: `/login?error=${reason}` });
      expect(screen.getByText(message)).toBeInTheDocument();
      unmount();
    }
  });
});
