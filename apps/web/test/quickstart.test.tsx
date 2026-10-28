import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPreview } from '@subcycle/shared';
import { deferred, fail, freezeTime, makeSub, ok, renderApp, signedInServer } from './helpers';

beforeEach(() => {
  freezeTime();
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const preview = (over: Partial<LinkPreview> = {}): LinkPreview => ({ name: 'Acme Cloud', websiteUrl: 'https://acme-cloud.com', category: null, icon: null, source: 'page', ...over });

function server(handler = ok(preview())) {
  return signedInServer()
    .on('POST', '/api/link-preview', handler)
    .on('POST', '/api/subscriptions', { status: 201, body: { data: makeSub({ id: 'new1' }) } })
    .on('GET', '/api/subscriptions/:id', ok(makeSub({ id: 'new1' })))
    .on('GET', '/api/subscriptions/:id/payments', ok([], { page: 1, pageSize: 25, total: 0 }))
    .on('GET', '/api/subscriptions/:id/price-history', ok([], { page: 1, pageSize: 25, total: 0 }))
    .on('GET', '/api/subscriptions/:id/upcoming', ok([]));
}

const open = async () => {
  const utils = renderApp('/subscriptions/new');
  const name = await screen.findByRole('combobox', { name: /Service name/ });
  return { ...utils, name };
};
const quick = () => within(screen.getByRole('heading', { name: 'Save some typing' }).closest('section')!);

describe('service name suggestions (built-in list)', () => {
  it('suggests matching services while typing, as an accessible combobox', async () => {
    server();
    const { user, name } = await open();
    expect(name).toHaveAttribute('aria-expanded', 'false');
    await user.type(name, 'net');
    expect(name).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Suggested services' });
    expect(name).toHaveAttribute('aria-controls', list.id);
    expect(within(list).getByRole('option', { name: /Netflix/ })).toBeInTheDocument();
    expect(screen.getByText(/suggestions? available/)).toBeInTheDocument(); // announced to screen readers
  });

  it('arrow keys move the highlight and Enter picks it WITHOUT submitting the form', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(name, 'net');
    await user.keyboard('{ArrowDown}');
    const option = screen.getByRole('option', { name: /Netflix/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(name).toHaveAttribute('aria-activedescendant', option.id);
    await user.keyboard('{Enter}');
    expect(name).toHaveValue('Netflix');
    expect(screen.getByLabelText('Category')).toHaveValue('video');
    expect(screen.getByLabelText('Website (optional)')).toHaveValue('https://www.netflix.com');
    expect(screen.getByLabelText('Icon (optional)')).toHaveValue('netflix');
    expect(document.querySelector('[data-logo="netflix"]')).not.toBeNull(); // the Netflix logo is previewed next to the field
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(s.to('POST', '/api/subscriptions')).toHaveLength(0);
    expect(quick().getByRole('status')).toHaveTextContent(/Filled in the details for Netflix\. Now add the price and your next billing date/);
  });

  it('never fills a price or a date', async () => {
    server();
    const { user, name } = await open();
    await user.type(name, 'spot');
    await user.click(screen.getByRole('option', { name: /Spotify/ }));
    expect(name).toHaveValue('Spotify');
    expect(screen.getByLabelText(/Price per billing period/)).toHaveValue('');
    expect(screen.getByLabelText(/Next billing date/)).toHaveValue('');
  });

  it('Enter with nothing highlighted still submits the form as before (validation shows)', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(name, 'net');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toBeInTheDocument(); // price/date missing
    expect(s.to('POST', '/api/subscriptions')).toHaveLength(0);
  });

  it('Escape closes the list and keeps what was typed; Tab leaves without picking', async () => {
    server();
    const { user, name } = await open();
    await user.type(name, 'net');
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(name).toHaveValue('net');
    await user.type(name, 'f');
    await user.keyboard('{ArrowDown}{Tab}');
    expect(name).toHaveValue('netf');
    expect(screen.getByLabelText('Category')).toHaveValue('other');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('a service that is not in the list: no suggestions, free typing as before', async () => {
    server();
    const { user, name } = await open();
    await user.type(name, 'My local gym');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(name).toHaveValue('My local gym');
  });

  it('picking never overwrites a category, website or icon the user already chose', async () => {
    server();
    const { user, name } = await open();
    await user.selectOptions(screen.getByLabelText('Category'), 'utilities');
    await user.type(screen.getByLabelText('Website (optional)'), 'https://mine.example.org');
    await user.type(screen.getByLabelText('Icon (optional)'), '🔥');
    await user.type(name, 'netf');
    await user.click(screen.getByRole('option', { name: /Netflix/ }));
    expect(screen.getByLabelText('Category')).toHaveValue('utilities');
    expect(screen.getByLabelText('Website (optional)')).toHaveValue('https://mine.example.org');
    expect(screen.getByLabelText('Icon (optional)')).toHaveValue('🔥');
    expect(name).toHaveValue('Netflix');
  });

  it('the picked values are what gets saved, with the price and date the user typed', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(name, 'spot');
    await user.click(screen.getByRole('option', { name: /Spotify/ }));
    await user.type(screen.getByLabelText(/Price per billing period/), '119');
    await user.type(screen.getByLabelText(/Next billing date/), '2030-02-10');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(s.to('POST', '/api/subscriptions')).toHaveLength(1));
    expect(s.last('POST', '/api/subscriptions')!.body).toMatchObject({
      name: 'Spotify', category: 'music', websiteUrl: 'https://www.spotify.com', icon: { kind: 'glyph', value: 'spotify' }, amountMinor: 11900, nextBillingDate: '2030-02-10',
    });
  });

  it('the list is keyboard- and axe-clean while open', async () => {
    server();
    const { user, name } = await open();
    await user.type(name, 'a');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });

  it('editing an existing subscription has no suggestions and no quick start', async () => {
    signedInServer().on('GET', '/api/subscriptions/:id', ok(makeSub({ id: 'e1', name: 'Netflix' })));
    renderApp('/subscriptions/e1/edit');
    const name = await screen.findByLabelText(/Service name/);
    expect(name).not.toHaveAttribute('role', 'combobox');
    expect(screen.queryByRole('heading', { name: 'Save some typing' })).not.toBeInTheDocument();
  });
});

describe('fill from a pasted link', () => {
  it('a well-known service is recognised locally: nothing is sent to the server', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'https://www.netflix.com/browse?token=secret');
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    expect(name).toHaveValue('Netflix');
    expect(screen.getByLabelText('Category')).toHaveValue('video');
    expect(screen.getByLabelText('Website (optional)')).toHaveValue('https://www.netflix.com');
    expect(quick().getByRole('status')).toHaveTextContent(/Recognised Netflix\. Filled in name, category, website and icon/);
    expect(s.to('POST', '/api/link-preview')).toHaveLength(0);
  });

  it('Enter in the link field fills from the link and does NOT submit the form', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'spotify.com{Enter}');
    expect(name).toHaveValue('Spotify');
    expect(s.to('POST', '/api/subscriptions')).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an unknown site is looked up by the server: only the pasted text is sent, and the page title is offered for checking', async () => {
    const s = server();
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'acme-cloud.com/pricing');
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    await waitFor(() => expect(name).toHaveValue('Acme Cloud'));
    expect(s.last('POST', '/api/link-preview')!.body).toEqual({ url: 'acme-cloud.com/pricing' });
    expect(s.last('POST', '/api/link-preview')!.headers.get('X-SubCycle-Client')).toBe('web');
    expect(screen.getByLabelText('Website (optional)')).toHaveValue('https://acme-cloud.com');
    expect(screen.getByLabelText('Category')).toHaveValue('other'); // nothing guessed
    expect(screen.getByLabelText('Icon (optional)')).toHaveValue('');
    expect(quick().getByRole('status')).toHaveTextContent(/Read “Acme Cloud” from the page\. Filled in name and website: check the name/);
    expect(screen.getByLabelText(/Price per billing period/)).toHaveValue('');
  });

  it('when the page could not be read it says so and asks the user to check the name', async () => {
    server(ok(preview({ name: 'Some shop', websiteUrl: 'https://some-shop.com', source: 'address' })));
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'some-shop.com');
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    await waitFor(() => expect(name).toHaveValue('Some shop'));
    expect(quick().getByRole('status')).toHaveTextContent(/couldn’t read that page, so the name comes from the web address: check it/);
  });

  it('keeps a name the user already typed and fills only what is empty', async () => {
    server();
    const { user, name } = await open();
    await user.type(name, 'My plan');
    await user.type(quick().getByLabelText(/Paste a website link/), 'acme-cloud.com{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Website (optional)')).toHaveValue('https://acme-cloud.com'));
    expect(name).toHaveValue('My plan');
    expect(quick().getByRole('status')).toHaveTextContent(/Filled in website/);
  });

  it('an address the server refuses shows its fixed message next to the field and fills nothing', async () => {
    server(fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'url', message: 'Enter the web address of a public website, such as https://example.com.' }]));
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), '192.168.1.1');
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    expect(await quick().findByText('Enter the web address of a public website, such as https://example.com.')).toBeInTheDocument();
    expect(name).toHaveValue('');
    expect(screen.getByLabelText('Website (optional)')).toHaveValue('');
  });

  it.each([
    [429, 'RATE_LIMITED', /Too many lookups/],
    [500, 'INTERNAL_ERROR', /couldn’t look that up\. You can type the details in instead/],
  ])('a %i response is explained and the form stays usable', async (status, code, message) => {
    server(fail(status, code, 'x'));
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'acme-cloud.com');
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    expect(await quick().findByText(message)).toBeInTheDocument();
    await user.type(name, 'Typed by hand');
    expect(name).toHaveValue('Typed by hand');
  });

  it('empty input asks for an address and sends nothing', async () => {
    const s = server();
    const { user } = await open();
    await user.click(quick().getByRole('button', { name: 'Fill from link' }));
    expect(await quick().findByText('Paste a web address first.')).toBeInTheDocument();
    expect(s.to('POST', '/api/link-preview')).toHaveLength(0);
  });

  it('a double click sends one lookup', async () => {
    const gate = deferred();
    const s = server(undefined);
    s.on('POST', '/api/link-preview', () => gate.promise);
    const { user, name } = await open();
    await user.type(quick().getByLabelText(/Paste a website link/), 'acme-cloud.com');
    await user.dblClick(quick().getByRole('button', { name: 'Fill from link' }));
    gate.resolve(ok(preview()));
    await waitFor(() => expect(name).toHaveValue('Acme Cloud'));
    expect(s.to('POST', '/api/link-preview')).toHaveLength(1);
  });
});
