import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VcsProviderMark } from '@client/components/shared/vcs-provider-mark';

describe('VcsProviderMark', () => {
  it('renders an accessible GitHub mark by default for legacy data', () => {
    render(<VcsProviderMark />);

    const mark = screen.getByRole('img', { name: 'GitHub' });
    expect(mark).toHaveAttribute('title', 'GitHub');
    expect(mark.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('renders a sized Bitbucket mark', () => {
    render(<VcsProviderMark provider="bitbucket" size={14} />);

    const mark = screen.getByRole('img', { name: 'Bitbucket' });
    expect(mark).toHaveAttribute('title', 'Bitbucket');
    expect(mark.querySelector('svg')).toHaveAttribute('width', '14');
    expect(mark.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });
});
