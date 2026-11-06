import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Markdown } from '../../src/components/Markdown';

describe('Markdown', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('renders headings, lists and tables as real elements', () => {
    const text = '## Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const { container } = render(<Markdown text={text} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Title');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('.table table td')?.textContent).toBe('1');
  });

  it('keeps a raw tag as text, so an answer cannot put HTML in the page', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> and <b>bold</b>'} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('turns an image into a link rather than loading it', () => {
    const { container } = render(<Markdown text="![a chart](http://tracker.example/p.png)" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'a chart' }).getAttribute('href')).toBe('http://tracker.example/p.png');
  });

  it('refuses a script address in a link', () => {
    const { container } = render(<Markdown text="[click](javascript:alert(1))" />);
    expect(screen.getByText('click').textContent).toBe('click');
    expect(container.innerHTML).not.toContain('javascript');
  });

  it('opens links in a new tab without handing over the page', () => {
    render(<Markdown text="[docs](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('names the language of a code block and copies its text', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    render(<Markdown text={'```python\nprint("hi")\n```'} />);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    expect(screen.getByText('python')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toBeCalledWith('print("hi")'));
  });

  it('survives a code fence that has not closed yet', () => {
    const { container } = render(<Markdown text={'```js\nconst a ='} />);
    expect(container.querySelector('pre code')?.textContent).toContain('const a =');
  });
});
