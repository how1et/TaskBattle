import Link from 'next/link';
export function SiteHeader() {
  return (
    <header className="topbar">
      <Link prefetch={false} className="brand" href="/" aria-label="TaskBattle — на главную">
        <span className="brand-icon" aria-hidden="true">
          <img src="/images/quest-emblem.webp" width="45" height="48" alt="" />
        </span>
        <span>
          Task<span className="brand-gold">Battle</span>
        </span>
      </Link>
    </header>
  );
}
