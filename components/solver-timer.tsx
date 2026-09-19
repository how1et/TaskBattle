'use client';
import { duration } from '@/lib/time';
import { useEffect, useState } from 'react';
/** Its 10 Hz updates never render the form, task image or route. */
export function SolverTimer({
  completedMs,
  readTime,
}: {
  completedMs: number;
  readTime: () => number;
}) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const tick = () => setValue(readTime());
    tick();
    const timer = setInterval(tick, 100);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [readTime]);
  return (
    <span className="timer" aria-label="Общий таймер">
      {duration(completedMs + value)}
    </span>
  );
}
