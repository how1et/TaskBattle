'use client';
import { useRef, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api, type AttemptData } from '@/lib/client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogFooter,
} from './ui/alert-dialog';
export function ExportResults({ data, secret }: { data: AttemptData; secret: string }) {
  const [format, setFormat] = useState('amc8'),
    [year, setYear] = useState(String(data.amcYear || '')),
    [error, setError] = useState(''),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const out = await api<{ url: string }>(`/attempts/${data.attemptId}/export`, secret, true, {
        format,
        year,
      });
      setUrl(out.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить лист. Повторите.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button className="primary">
          <Download size={18} />
          Сохранить результаты
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Сохранить в Google Таблицы</AlertDialogTitle>
        <AlertDialogDescription>
          В документе «Результаты TASKBATTLE» появится отдельный лист для этой попытки. Повторное
          сохранение откроет тот же лист.
        </AlertDialogDescription>
        <div className="export-form">
          <label>
            Формат
            <select
              aria-label="Формат экспорта"
              value={format}
              disabled={busy}
              onChange={(e) => {
                setFormat(e.target.value);
                setUrl('');
                setError('');
              }}
            >
              <option value="amc8">Шаблон AMC8</option>
              <option value="free">Свободная форма</option>
            </select>
          </label>
          {format === 'amc8' ? (
            <>
              <p className="small muted">
                25 строк. Номера соответствуют порядку задач в подборке.
              </p>
              <label>
                Год AMC
                <Input
                  className="text-input"
                  inputMode="numeric"
                  aria-label="Год AMC для экспорта"
                  maxLength={4}
                  value={year}
                  disabled={busy || !!data.amcYear}
                  onChange={(e) => setYear(e.target.value)}
                />
              </label>
            </>
          ) : (
            <p className="small muted">
              Только задачи с принятым ответом, включая неверные. Время на остальные задачи укажем
              отдельно.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {url && (
            <a className="link-text row" href={url} target="_blank" rel="noreferrer">
              <ExternalLink size={18} />
              Открыть сохранённый лист
            </a>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel className="secondary" disabled={busy}>
            Закрыть
          </AlertDialogCancel>
          <Button
            className="primary"
            disabled={busy || (format === 'amc8' && !/^\d{4}$/.test(year))}
            onClick={() => void save()}
          >
            {busy ? 'Сохраняем…' : url ? 'Открыть тот же результат' : 'Подтвердить сохранение'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
