// The FLOW HQ shell: black sidebar, blue active states, top bar with command palette, theme and account.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown, LogOut, Menu, Moon, Search, Sun, X } from 'lucide-react';
import { MODULES } from '@core/registry';
import type { ModuleKey } from '@core/domain';
import { useWs } from '../../lib/workspace';
import { useTheme } from '../../lib/theme';
import { icon } from '../../lib/icons';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Avatar, Badge, Kbd } from '../ui/primitives';
import { CommandPalette } from './CommandPalette';

export function Logo({ compact }: { compact?: boolean }) {
  const gid = `fhq-g${useId().replace(/:/g, '')}`;   // unique: a hidden copy of the logo must not own the gradient
  return (
    <div className="flex items-center gap-2.5">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" className="drop-shadow-[0_0_12px_rgb(var(--blue)/0.55)]">
        <defs><linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3B8DFF" /><stop offset="1" stopColor="#1677FF" /></linearGradient></defs>
        <rect width="32" height="32" rx="8" fill="#0D111A" stroke="#1D2735" />
        <path d="M8 10.5h11.5a3.5 3.5 0 0 1 0 7H13a3.5 3.5 0 0 0 0 7h11" fill="none" stroke={`url(#${gid})`} strokeWidth="3" strokeLinecap="round" />
        <circle cx="24" cy="24.5" r="2" fill="#7DB2FF" />
      </svg>
      {!compact && <span className="text-[15px] font-semibold tracking-tight">FLOW <span className="text-blue-bright">HQ</span></span>}
    </div>
  );
}

export function pagePath(wsId: string, m: ModuleKey) { const p = MODULES[m].page; return p === '/' ? `/w/${wsId}` : `/w/${wsId}${p}`; }

function WorkspaceSwitcher() {
  const { ws, me } = useWs();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const industryLabel = (k: string) => me.industries.find((i) => i.key === k)?.label || k;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface/60 p-2 text-left transition-colors hover:border-line-2 hover:bg-surface" aria-haspopup="listbox" aria-expanded={open}>
        <Avatar text={ws.initials} src={ws.logoUrl} size={30} tone="blue" />
        <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{ws.name}</div><div className="truncate text-[11px] text-muted">{industryLabel(ws.industry)}</div></div>
        <ChevronsUpDown className="h-4 w-4 text-muted" />
      </button>
      {open && (
        <div role="listbox" className="absolute bottom-full left-0 z-30 mb-2 w-full rounded-xl border border-line bg-elevated p-1 shadow-pop animate-fade-up">
          <div className="label px-2 pb-1 pt-1.5">Workspaces</div>
          {me.workspaces.map((w) => (
            <button key={w.id} role="option" aria-selected={w.id === ws.id} onClick={() => { setOpen(false); try { localStorage.setItem('fhq-ws', w.id); } catch { /* ignore */ } nav(`/w/${w.id}`); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
              <Avatar text={w.initials} src={w.logoUrl} size={24} tone={w.id === ws.id ? 'blue' : 'neutral'} />
              <div className="min-w-0 flex-1"><div className="truncate text-[13px]">{w.name}</div><div className="truncate text-[11px] text-muted">{industryLabel(w.industry)}</div></div>
              {w.id === ws.id && <Check className="h-4 w-4 text-blue-bright" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { ws, tt } = useWs();
  const items = ws.modules.filter((m) => MODULES[m].page !== null).sort((a, b) => MODULES[a].order - MODULES[b].order);
  const main = items.filter((m) => m !== 'settings');
  return (
    <nav className="flex h-full flex-col gap-4 border-r border-line bg-bg-2 px-3 py-4" aria-label="Main">
      <div className="px-2 pt-1"><Logo /></div>
      <ul className="mt-2 space-y-0.5">
        {main.map((m) => <NavItem key={m} to={pagePath(ws.id, m)} label={tt(MODULES[m].label)} iconName={MODULES[m].icon} end={m === 'dashboard'} onNavigate={onNavigate} shortcut={MODULES[m].shortcut} />)}
      </ul>
      <div className="mt-auto space-y-3">
        <ul><NavItem to={pagePath(ws.id, 'settings')} label="Settings" iconName="settings" onNavigate={onNavigate} shortcut={MODULES.settings.shortcut} /></ul>
        <WorkspaceSwitcher />
      </div>
    </nav>
  );
}
function NavItem({ to, label, iconName, end, onNavigate, shortcut }: { to: string; label: string; iconName: string; end?: boolean; onNavigate?: () => void; shortcut?: string }) {
  const Icon = icon(iconName);
  return (
    <li>
      <NavLink to={to} end={end} onClick={onNavigate} title={shortcut ? `${label} (${shortcut})` : label}
        className={({ isActive }) => cn('group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition-all duration-150',
          isActive ? 'bg-blue/[0.12] text-fg shadow-[inset_0_0_0_1px_rgb(var(--blue)/0.25),0_0_24px_-10px_rgb(var(--blue)/0.6)]' : 'text-fg-2 hover:bg-surface hover:text-fg')}>
        {({ isActive }) => (<>
          {isActive && <span className="absolute -left-3 top-2 h-5 w-[3px] rounded-r bg-blue-bright shadow-[0_0_10px_rgb(var(--blue-bright))]" />}
          <Icon className={cn('h-[17px] w-[17px] transition-colors', isActive ? 'text-blue-bright' : 'text-muted group-hover:text-fg-2')} />
          <span className="truncate">{label}</span>
        </>)}
      </NavLink>
    </li>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { ws, me, tt } = useWs();
  const { theme, toggle } = useTheme();
  const [palette, setPalette] = useState(false);
  const [mobile, setMobile] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  useEffect(() => setMobile(false), [loc.pathname]);
  // keyboard: ⌘K / Ctrl+K palette, "g" + key to jump to a page
  const shortcuts = useMemo(() => Object.fromEntries(ws.modules.filter((m) => MODULES[m].shortcut && MODULES[m].page !== null).map((m) => [MODULES[m].shortcut!.split(' ')[1], pagePath(ws.id, m)])), [ws]);
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { g = Date.now(); return; }
      if (Date.now() - g < 1200 && shortcuts[e.key]) { e.preventDefault(); g = 0; nav(shortcuts[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, shortcuts]);
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => null); qc.clear(); nav('/login'); };
  return (
    <div className="flex h-full">
      <aside className="hidden w-[248px] shrink-0 lg:block"><Sidebar /></aside>
      {mobile && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobile(false)} />
          <div className="absolute left-0 top-0 h-full w-[264px] animate-fade-up"><Sidebar onNavigate={() => setMobile(false)} /></div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-xl md:px-6">
          <button className="rounded-lg p-1.5 text-fg-2 hover:bg-surface lg:hidden" onClick={() => setMobile(true)} aria-label="Open menu">{mobile ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          <div className="lg:hidden"><Logo compact /></div>
          <button onClick={() => setPalette(true)} aria-label="Search and commands" className="group flex h-9 min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface/70 px-3 text-left text-[13px] text-muted transition-colors hover:border-line-2 hover:text-fg-2">
            <Search className="h-4 w-4" />
            <span className="flex-1 truncate">{tt('Search {contact.plural|lower}, conversations, pages…')}</span>
            <span className="hidden items-center gap-1 sm:flex"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            {ws.demo && <Badge tone="blue" className="hidden sm:inline-flex">Demo data</Badge>}
            <button onClick={toggle} className="rounded-lg p-2 text-fg-2 transition-colors hover:bg-surface hover:text-fg" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>
            <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
              <Avatar text={me.user.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()} size={28} />
              <div className="leading-tight"><div className="text-[13px] font-medium">{me.user.name}</div><div className="text-[11px] capitalize text-muted">{me.user.role}</div></div>
            </div>
            <button onClick={signOut} className="rounded-lg p-2 text-fg-2 transition-colors hover:bg-surface hover:text-fg" aria-label="Sign out"><LogOut className="h-[18px] w-[18px]" /></button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

export function Page({ title, subtitle, actions, children, wide }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full animate-fade-up px-4 pb-12 pt-6 md:px-8', wide ? 'max-w-[1680px]' : 'max-w-[1400px]')}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0"><h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-1 text-sm text-fg-2">{subtitle}</p>}</div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
