'use client';
import { readLocal, writeLocal } from '@/lib/client';
import { LIMITS } from '@/lib/limits';
import { preparePhoto } from '@/lib/photo-preparation';
import { recoverRoom, UploadError, uploadRoom } from '@/lib/room-upload';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
type Draft = {
  file: File;
  url: string;
  answer: string;
  id: string;
};
export function useRoomCreator() {
  const [title, setTitle] = useState('');
  const [tasks, setTasks] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  const [sending, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const busy = sending || preparing;
  const addLock = useRef(false),
    alive = useRef(true),
    controller = useRef<AbortController | null>(null),
    urls = useRef(new Set<string>());
  const router = useRouter();
  useEffect(() => {
    alive.current = true;
    const owned = urls.current;
    return () => {
      alive.current = false;
      controller.current?.abort();
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);
  const [progress, setProgress] = useState('');
  const [recovering, setRecovering] = useState(false);
  const leaving = useRef(false);
  const creation = useRef<{
    id: string;
    key: string;
  } | null>(null);
  const lock = useRef(false);
  function resetCreation() {
    creation.current = null;
    writeLocal('pending-room', null);
    setRecovering(false);
  }
  function openRoom(out: { roomId: string; teacherKey: string }) {
    leaving.current = true;
    writeLocal('pending-room', null);
    router.push(`/teacher/${out.roomId}#${out.teacherKey}`);
  }
  async function checkPending() {
    const pending = readLocal<{ id: string; key: string }>('pending-room');
    if (!pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setProgress('Проверяем предыдущее создание…');
    try {
      const out = await recoverRoom(pending.id, pending.key);
      if (out) {
        openRoom(out);
        return;
      }
      resetCreation();
      setRecovering(false);
      setError('Предыдущее создание не завершилось. Добавьте фотографии и ответы ещё раз.');
    } catch (e) {
      if (e instanceof UploadError && e.status === 410) {
        resetCreation();
        setRecovering(false);
        setError(e.message);
      } else {
        setRecovering(true);
        setError(
          'Не удалось проверить предыдущее создание. Нажмите «Проверить создание», когда восстановится связь.',
        );
      }
    } finally {
      lock.current = false;
      setBusy(false);
      setProgress('');
    }
  }
  // Restore once on mount; user retries call the current handler explicitly.
  useEffect(() => {
    void checkPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!tasks.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!leaving.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [tasks.length]);
  async function add(files: FileList | null) {
    if (!files || !files.length || busy || addLock.current) return;
    const list = Array.from(files);
    if (tasks.length + list.length > LIMITS.tasks) {
      setError('Можно добавить не больше 25 задач.');
      return;
    }
    addLock.current = true;
    setPreparing(true);
    setError('');
    controller.current = new AbortController();
    const prepared: File[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        setProgress('Готовим фотографии: ' + (i + 1) + ' из ' + list.length);
        prepared.push(await preparePhoto(list[i], controller.current.signal));
      }
      if (!alive.current) return;
      if (
        [...tasks.map((t) => t.file), ...prepared].reduce((sum, f) => sum + f.size, 0) >
        LIMITS.roomBytes
      )
        throw new Error(
          'После уменьшения фотографии занимают больше 18 МБ. Добавьте меньше задач или выберите меньшие снимки.',
        );
      const added = prepared.map((file) => {
        const url = URL.createObjectURL(file);
        urls.current.add(url);
        return { file, url, answer: '', id: crypto.randomUUID() };
      });
      resetCreation();
      setTasks((old) => [...old, ...added]);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : 'Не удалось обработать фотографии. Повторите выбор.',
        );
    } finally {
      addLock.current = false;
      if (alive.current) {
        setPreparing(false);
        setProgress('');
      }
    }
  }
  function removeTask(id: string) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    resetCreation();
    URL.revokeObjectURL(task.url);
    urls.current.delete(task.url);
    setTasks((old) => old.filter((t) => t.id !== id));
  }
  async function create() {
    if (lock.current || preparing || !tasks.length || tasks.some((t) => !t.answer.trim())) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      creation.current ??= {
        id: crypto.randomUUID(),
        key: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      };
      writeLocal('pending-room', creation.current);
      const data = new FormData();
      data.set('requestId', creation.current.id);
      data.set('teacherKey', creation.current.key);
      data.set('title', title);
      data.set('answers', JSON.stringify(tasks.map((t) => t.answer)));
      tasks.forEach((t) => data.append('photos', t.file));
      const out = await uploadRoom(data, setProgress);
      openRoom(out);
    } catch (e) {
      setError(
        e instanceof UploadError
          ? e.message
          : 'Не удалось создать комнату. Фотографии и ответы остались в форме — повторите создание.',
      );
    } finally {
      setBusy(false);
      setProgress('');
      lock.current = false;
    }
  }

  return {
    title,
    setTitle,
    tasks,
    setTasks,
    error,
    busy,
    preparing,
    progress,
    recovering,
    creation,
    resetCreation,
    checkPending,
    add,
    create,
    removeTask,
  };
}
