import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceIcon } from '../src/components/ui/display';
import { ICON_PIXELS, IconImageError, prepareIconImage, type Decoder } from '../src/lib/iconImage';
import { fail, freezeTime, makeSub, ok, renderApp, signedInServer } from './helpers';

const file = (type: string, size = 100, name = 'pic') => new File([new Uint8Array(size)], name, { type });

/** A fake browser: records the crop it was asked for and produces blobs of chosen sizes per encoding attempt. */
function fakeDecoder(opts: { width?: number; height?: number; sizes?: Record<string, number>; decodeFails?: boolean; noContext?: boolean } = {}) {
  const log = { crop: null as null | { sx: number; sy: number; side: number }, closed: 0, encodes: [] as string[], canvas: 0 };
  const decoder: Decoder = {
    async decode() {
      if (opts.decodeFails) throw new Error('bad image');
      return { width: opts.width ?? 400, height: opts.height ?? 300, draw: (_c, sx, sy, side) => { log.crop = { sx, sy, side }; }, close: () => { log.closed++; } };
    },
    canvas() {
      log.canvas++;
      return {
        getContext: () => (opts.noContext ? null : ({} as CanvasRenderingContext2D)),
        toBlob(cb, type, quality) {
          log.encodes.push(`${type}@${quality ?? '-'}`);
          const size = opts.sizes?.[`${type}@${quality ?? '-'}`] ?? 5000;
          cb(size < 0 ? null : new Blob([new Uint8Array(size)], { type }));
        },
      };
    },
  };
  return { decoder, log };
}

describe('prepareIconImage', () => {
  it('crops the centre square, shrinks to 128 x 128 and re-encodes as WebP', async () => {
    const { decoder, log } = fakeDecoder({ width: 400, height: 300 });
    const out = await prepareIconImage(file('image/jpeg'), decoder);
    expect(out.type).toBe('image/webp');
    expect(log.crop).toEqual({ sx: 50, sy: 0, side: 300 }); // centred square of the shorter side
    expect(ICON_PIXELS).toBe(128);
    expect(log.closed).toBe(1);
  });
  it('lowers the quality, then falls back to PNG, until it fits in 40 KB', async () => {
    const { decoder, log } = fakeDecoder({ sizes: { 'image/webp@0.9': 90_000, 'image/webp@0.75': 60_000, 'image/webp@0.55': -1 /* browser cannot encode webp */ } });
    expect((await prepareIconImage(file('image/png'), decoder)).type).toBe('image/png');
    expect(log.encodes).toEqual(['image/webp@0.9', 'image/webp@0.75', 'image/webp@0.55', 'image/png@-']);
  });
  it('gives up with a clear message when nothing fits', async () => {
    const { decoder, log } = fakeDecoder({ sizes: { 'image/webp@0.9': 90_000, 'image/webp@0.75': 90_000, 'image/webp@0.55': 90_000, 'image/png@-': 90_000 } });
    await expect(prepareIconImage(file('image/png'), decoder)).rejects.toThrow(/too detailed/);
    expect(log.closed).toBe(1);
  });
  it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', ''])('refuses %j before decoding anything', async (type) => {
    const { decoder, log } = fakeDecoder();
    await expect(prepareIconImage(file(type), decoder)).rejects.toThrow(IconImageError);
    expect(log.canvas).toBe(0);
  });
  it('refuses an original over 8 MB, an undecodable file, an empty image and a missing canvas', async () => {
    await expect(prepareIconImage(file('image/png', 9 * 1024 * 1024), fakeDecoder().decoder)).rejects.toThrow(/under 8 MB/);
    await expect(prepareIconImage(file('image/png'), fakeDecoder({ decodeFails: true }).decoder)).rejects.toThrow(/could not be read/);
    await expect(prepareIconImage(file('image/png'), fakeDecoder({ width: 0, height: 10 }).decoder)).rejects.toThrow(/empty/);
    const noCtx = fakeDecoder({ noContext: true });
    await expect(prepareIconImage(file('image/png'), noCtx.decoder)).rejects.toThrow(/can’t prepare/);
    expect(noCtx.log.closed).toBe(1);
  });
});

describe('ServiceIcon with a picture', () => {
  const sub = (value: string) => ({ name: 'My gym', category: 'fitness_health' as const, icon: { kind: 'image' as const, value } });
  it('shows a same-origin picture as a decorative tile', () => {
    const { container } = render(<ServiceIcon subscription={sub('/api/subscriptions/abc/icon-image?v=0123456789abcdef')} />);
    const img = container.querySelector('[data-picture] img')!;
    expect(img.getAttribute('src')).toBe('/api/subscriptions/abc/icon-image?v=0123456789abcdef');
    expect(img).toHaveAttribute('alt', '');
    expect(container.querySelector('[data-picture]')).toHaveAttribute('aria-hidden', 'true');
  });
  it('falls back to the letter tile when the picture cannot load', () => {
    const { container } = render(<ServiceIcon subscription={sub('/api/subscriptions/abc/icon-image?v=0123456789abcdef')} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('M');
  });
  it.each(['https://evil.example/x.png', 'http://tracker.example/p.gif', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'javascript:alert(1)'])('never loads a non-local address (%s)', (value) => {
    const { container } = render(<ServiceIcon subscription={sub(value)} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('M');
  });
});

// ───────────── the form control ─────────────

beforeEach(() => {
  freezeTime();
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/lib/iconImage');
});

const PNG = new Blob([new Uint8Array(1200)], { type: 'image/png' });
async function withPreparedImage() {
  vi.resetModules();
  vi.doMock('../src/lib/iconImage', async (orig) => ({ ...(await orig<typeof import('../src/lib/iconImage')>()), prepareIconImage: vi.fn(async () => PNG) }));
}

function formServer(extra?: (s: ReturnType<typeof signedInServer>) => void) {
  const created = makeSub({ id: 'new1', name: 'My gym' });
  const s = signedInServer()
    .on('POST', '/api/subscriptions', { status: 201, body: { data: created } })
    .on('GET', '/api/subscriptions/:id', ok(created))
    .on('GET', '/api/subscriptions/:id/payments', ok([], { page: 1, pageSize: 25, total: 0 }))
    .on('GET', '/api/subscriptions/:id/price-history', ok([], { page: 1, pageSize: 25, total: 0 }))
    .on('GET', '/api/subscriptions/:id/upcoming', ok([]));
  extra?.(s);
  return s;
}

async function loadApp() {
  await withPreparedImage();
  const { renderApp: render2 } = await import('./helpers');
  return render2;
}

describe('the "your own picture" control', () => {
  it('create: the chosen picture is previewed, held, and uploaded right after the subscription is created', async () => {
    const s = formServer((srv) => srv.on('PUT', '/api/subscriptions/:id/icon-image', ok(makeSub({ id: 'new1' }))));
    const render2 = await loadApp();
    const { user } = render2('/subscriptions/new');
    await screen.findByLabelText(/Service name/);
    const input = screen.getByLabelText(/Your own picture/) as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
    await user.upload(input, new File(['x'], 'gym.png', { type: 'image/png' }));
    expect(await screen.findByText(/Picture ready\. It is saved when you add the subscription/)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-picture-preview]')?.getAttribute('src')).toMatch(/^data:image\/png/)); // data: URL (blob: is blocked by the CSP)
    expect(s.to('PUT', /icon-image/)).toHaveLength(0); // nothing is sent before the subscription exists
    await user.type(screen.getByLabelText(/Service name/), 'My gym');
    await user.type(screen.getByLabelText(/Price per billing period/), '999');
    await user.type(screen.getByLabelText(/Next billing date/), '2030-02-10');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(s.to('PUT', '/api/subscriptions/new1/icon-image')).toHaveLength(1));
    const put = s.last('PUT', '/api/subscriptions/new1/icon-image')!;
    expect(put.headers.get('Content-Type')).toBe('image/png');
    expect(put.headers.get('X-SubCycle-Client')).toBe('web');
    expect(put.credentials).toBe('same-origin');
    expect(await screen.findByRole('heading', { name: 'My gym', level: 1 })).toBeInTheDocument();
  });

  it('create: if the picture cannot be saved the subscription is still added, and the user is told', async () => {
    formServer((srv) => srv.on('PUT', '/api/subscriptions/:id/icon-image', fail(422, 'VALIDATION_ERROR', 'x', [{ path: 'image', message: 'That file is not a valid PNG, JPEG or WebP image.' }])));
    const render2 = await loadApp();
    const { user } = render2('/subscriptions/new');
    await user.upload(await screen.findByLabelText(/Your own picture/), new File(['x'], 'gym.png', { type: 'image/png' }));
    await screen.findByText(/Picture ready/);
    await user.type(screen.getByLabelText(/Service name/), 'My gym');
    await user.type(screen.getByLabelText(/Price per billing period/), '999');
    await user.type(screen.getByLabelText(/Next billing date/), '2030-02-10');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    expect(await screen.findByText(/Added My gym, but its picture couldn’t be saved/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'My gym', level: 1 })).toBeInTheDocument();
  });

  it('create: "Remove picture" discards the held picture and nothing is uploaded', async () => {
    const s = formServer();
    const render2 = await loadApp();
    const { user } = render2('/subscriptions/new');
    await user.upload(await screen.findByLabelText(/Your own picture/), new File(['x'], 'gym.png', { type: 'image/png' }));
    await user.click(await screen.findByRole('button', { name: 'Remove picture' }));
    expect(await screen.findByText('Picture removed.')).toBeInTheDocument();
    expect(document.querySelector('[data-picture-preview]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove picture' })).not.toBeInTheDocument();
    expect(s.to('PUT', /icon-image/)).toHaveLength(0);
    expect(s.to('DELETE', /icon-image/)).toHaveLength(0);
  });

  it('edit: choosing a picture saves it straight away; the existing one is shown and can be removed', async () => {
    const existing = makeSub({ id: 'e1', name: 'My gym', icon: { kind: 'image', value: '/api/subscriptions/e1/icon-image?v=0123456789abcdef' } });
    const s = signedInServer()
      .on('GET', '/api/subscriptions/:id', ok(existing))
      .on('PUT', '/api/subscriptions/:id/icon-image', ok(existing))
      .on('DELETE', '/api/subscriptions/:id/icon-image', ok(makeSub({ id: 'e1', icon: null })));
    const render2 = await loadApp();
    const { user } = render2('/subscriptions/e1/edit');
    await screen.findByLabelText(/Service name/);
    expect(document.querySelector('[data-picture-preview]')?.getAttribute('src')).toBe('/api/subscriptions/e1/icon-image?v=0123456789abcdef');
    expect(screen.getByLabelText(/^Icon/)).toHaveValue(''); // the picture is not shown as text in the emoji / logo field
    await user.upload(screen.getByLabelText(/Your own picture/), new File(['x'], 'new.png', { type: 'image/png' }));
    expect(await screen.findByText('Picture saved.')).toBeInTheDocument();
    expect(s.to('PUT', '/api/subscriptions/e1/icon-image')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove picture' }));
    expect(await screen.findByText('Picture removed.')).toBeInTheDocument();
    expect(s.to('DELETE', '/api/subscriptions/e1/icon-image')).toHaveLength(1);
  });

  it('shows the server\'s reason when a picture is refused, and nothing is claimed as saved', async () => {
    signedInServer()
      .on('GET', '/api/subscriptions/:id', ok(makeSub({ id: 'e1' })))
      .on('PUT', '/api/subscriptions/:id/icon-image', fail(422, 'VALIDATION_ERROR', 'x', [{ path: 'image', message: 'The image must be at most 1024 x 1024 pixels.' }]));
    const render2 = await loadApp();
    const { user } = render2('/subscriptions/e1/edit');
    await user.upload(await screen.findByLabelText(/Your own picture/), new File(['x'], 'huge.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The image must be at most 1024 x 1024 pixels.');
    expect(screen.queryByText('Picture saved.')).not.toBeInTheDocument();
  });

  it('an unusable file is explained before anything is sent', async () => {
    vi.resetModules();
    const s = signedInServer().on('GET', '/api/subscriptions/:id', ok(makeSub({ id: 'e1' })));
    const { renderApp: render2 } = await import('./helpers');
    const { user } = render2('/subscriptions/e1/edit');
    const input = await screen.findByLabelText(/Your own picture/);
    fireEvent.change(input, { target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP image.');
    expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
    void user;
  });

  it('is labelled, described and free of accessibility violations', async () => {
    formServer();
    const { user } = renderApp('/subscriptions/new');
    await screen.findByLabelText(/Service name/);
    const input = screen.getByLabelText(/Your own picture/);
    expect(input).toHaveAccessibleDescription(/cropped to a square and shrunk to 128 × 128/);
    await userEvent.setup().tab();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    expect(within(screen.getByTestId('icon-image-field')).getByRole('status')).toBeInTheDocument();
    void user;
  });
});
