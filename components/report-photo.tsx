'use client';
import { useEffect, useRef, useState } from 'react';
import { Photo } from './quest-presentation';
import { Button } from './ui/button';
import { usePhotos } from './use-photos';
export function ReportPhoto({
  path,
  secret,
  teacher,
  label,
}: {
  path: string;
  secret: string;
  teacher: boolean;
  label: string;
}) {
  const target = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!target.current) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => setVisible(entries[0].isIntersecting), {
      rootMargin: '300px',
    });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, []);
  const { photos, error, retry } = usePhotos(visible ? [{ id: path, path }] : [], secret, teacher);
  return (
    <div ref={target} style={{ minHeight: 220 }}>
      {photos[path] ? (
        <Photo src={photos[path]} label={label} small />
      ) : error ? (
        <div className="error" role="alert">
          {error}
          <Button className="secondary" onClick={retry}>
            Повторить загрузку
          </Button>
        </div>
      ) : (
        <p className="muted">{visible ? 'Загружаем фотографию…' : 'Фотография'}</p>
      )}
    </div>
  );
}
