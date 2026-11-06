import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ChartIcon, CheckIcon, StopIcon } from '../../src/components/icons';

describe('icons', () => {
  it('stay out of the accessibility tree: the button around them has the name', () => {
    const { container } = render(
      <>
        <CheckIcon />
        <StopIcon />
        <ChartIcon />
      </>,
    );
    const icons = [...container.querySelectorAll('svg')];
    expect(icons).toHaveLength(3);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});
