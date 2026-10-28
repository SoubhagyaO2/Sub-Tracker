import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { iconImageApi } from '../api/endpoints';
import { IconImageError, prepareIconImage } from '../lib/iconImage';
import { Button } from './ui/Button';

interface Props {
  /** Editing an existing subscription: pictures are saved and removed straight away. */
  subscriptionId?: string;
  /** The picture the subscription already has (URL), if any. */
  currentUrl?: string | null;
  /** Creating: the chosen picture is held here and uploaded right after the subscription is created. */
  pending?: Blob | null;
  onPending?: (image: Blob | null) => void;
  /** Called after a picture was saved or removed on the server (edit mode), so the page can refresh. */
  onChanged?: () => void;
}

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Optional "use my own picture" control. The picture is cropped to a square and shrunk to 128 x 128 in the browser before
 * anything is sent; it is stored with the subscription, shown only to its owner, and never fetched from or sent to anyone else.
 * (The preview uses a data: URL because the app's Content-Security-Policy does not allow blob: images.)
 */
export function IconImageField({ subscriptionId, currentUrl, pending, onPending, onChanged }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!pending) setPreview(null);
    else void readAsDataUrl(pending).then((u) => live && setPreview(u), () => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [pending]);

  const shown = preview ?? currentUrl ?? null;

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const image = await prepareIconImage(file);
      if (subscriptionId) {
        await iconImageApi.upload(subscriptionId, image);
        setNote('Picture saved.');
        onChanged?.();
      } else {
        onPending?.(image);
        setNote('Picture ready. It is saved when you add the subscription.');
      }
    } catch (err) {
      setError(err instanceof IconImageError ? err.message : err instanceof ApiError ? (err.details[0]?.message ?? err.message) : 'We couldn’t use that picture. Try another one.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ''; // choosing the same file again must still fire
    }
  }

  async function remove() {
    if (busy) return;
    setError(null);
    setNote(null);
    if (!subscriptionId) {
      onPending?.(null);
      setNote('Picture removed.');
      return;
    }
    setBusy(true);
    try {
      await iconImageApi.remove(subscriptionId);
      setNote('Picture removed.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'We couldn’t remove the picture. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="icon-image-field">
      <label htmlFor={`${id}-file`} className="block text-sm font-medium text-fg">
        Your own picture <span className="font-normal text-muted">(optional)</span>
      </label>
      <div className="flex items-center gap-3">
        {shown ? <img src={shown} alt="" data-picture-preview className="h-12 w-12 shrink-0 rounded-control bg-raised object-cover" /> : null}
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          aria-describedby={`${id}-hint`}
          onChange={(e) => void choose(e.target.files?.[0])}
          className="block min-w-0 flex-1 text-sm text-muted file:mr-3 file:min-h-10 file:rounded-control file:border file:border-strong file:bg-raised file:px-3 file:text-sm file:font-semibold file:text-fg"
        />
        {shown ? (
          <Button size="sm" onClick={() => void remove()} disabled={busy}>
            Remove picture
          </Button>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted">
        PNG, JPEG or WebP. It is cropped to a square and shrunk to 128 × 128 pixels on your device before it is saved with this subscription; only you can see it. Choosing a logo or emoji instead replaces it.
      </p>
      <p role="status" className="text-sm text-accent-text empty:hidden">{note}</p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
