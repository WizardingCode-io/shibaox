import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLogo, brandOf } from '../src/screens/customize/logos.js';

describe('brand logos', () => {
  it('known services get their mark (simple-icons path), by id or by vendor', () => {
    expect(brandOf('github', 'GitHub')?.slug).toBe('github');
    expect(brandOf('context7', 'Upstash')?.slug).toBe('upstash');
    expect(brandOf('fetch', 'Model Context Protocol')?.slug).toBe('modelcontextprotocol');
    expect(brandOf('cloudflare-docs', 'Cloudflare')?.slug).toBe('cloudflare');
    expect(brandOf('telegram', 'Telegram')?.slug).toBe('telegram');
  });
  it('unknown services get a monogram of the name, never a broken image', () => {
    expect(brandOf('higgsfield', 'Higgsfield')).toBeUndefined();
    const { container } = render(<BrandLogo id="higgsfield" name="Higgsfield" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('H');
    expect(container.querySelector('img')).toBeNull();
  });
  it('renders an inline svg with the path and the service name as its label', () => {
    const { container } = render(<BrandLogo id="github" name="GitHub" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-logo')).toBe('github');
    expect(svg?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(svg?.getAttribute('aria-label')).toBe('GitHub');
  });
});
