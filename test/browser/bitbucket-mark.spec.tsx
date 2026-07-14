import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BitbucketMark } from '@client/components/shared/bitbucket-mark';

describe('BitbucketMark', () => {
  it('renders an svg with aria-hidden, viewBox, and currentColor fill', () => {
    const { container } = render(<BitbucketMark />);
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('defaults to size 16 for both width and height', () => {
    const { container } = render(<BitbucketMark />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
  });

  it('the size prop controls both width and height', () => {
    const { container } = render(<BitbucketMark size={17} />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('width', '17');
    expect(svg).toHaveAttribute('height', '17');
  });

  it('forwards the className prop onto the svg element', () => {
    const { container } = render(<BitbucketMark className="test-class" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveClass('test-class');
  });
});
