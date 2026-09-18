import { Shield } from 'lucide-react';

export function SiteHeader() {
    return <header className="topbar">
        <a className="brand" href="/" aria-label="TaskBattle — на главную">
            <span className="brand-icon" aria-hidden="true"><img src="/images/quest-emblem.webp" width="45" height="48" alt=""/></span>
            <span>Task<span className="brand-gold">Battle</span></span>
        </a>
        <span className="header-note">Задачи на время</span>
        <span className="pill"><Shield size={14} aria-hidden="true"/>Без регистрации</span>
    </header>;
}
