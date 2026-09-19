'use client';
import { photoPool } from '@/lib/photo-loader';
import { useEffect, useRef, useState } from 'react';
export function usePhotos(items: { id: string; path: string }[], secret: string, teacher = false) {
  const signature = JSON.stringify(items),
    [photos, setPhotos] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [revision, retry] = useState(0);
  const handles = useRef(
    new Map<string, { path: string; release: () => void; promise: Promise<string> }>(),
  );
  useEffect(() => {
    const wanted = JSON.parse(signature) as { id: string; path: string }[];
    setError('');
    for (const [id, h] of handles.current)
      if (!wanted.some((t) => t.id === id && t.path === h.path)) {
        h.release();
        handles.current.delete(id);
      }
    setPhotos((old) =>
      Object.fromEntries(Object.entries(old).filter(([id]) => handles.current.has(id))),
    );
    for (const t of wanted) {
      if (handles.current.has(t.id)) continue;
      const h = { path: t.path, ...photoPool.acquire(t.path, secret, teacher) };
      handles.current.set(t.id, h);
      h.promise
        .then((url) => {
          if (handles.current.get(t.id) === h) setPhotos((old) => ({ ...old, [t.id]: url }));
        })
        .catch((e) => {
          if (handles.current.get(t.id) === h) {
            handles.current.delete(t.id);
            h.release();
            setError(e.message);
          }
        });
    }
  }, [signature, secret, teacher, revision]);
  useEffect(() => {
    const owned = handles.current;
    return () => {
      for (const h of owned.values()) h.release();
      owned.clear();
    };
  }, [secret, teacher]);
  return { photos, error, retry: () => retry((n) => n + 1) };
}
