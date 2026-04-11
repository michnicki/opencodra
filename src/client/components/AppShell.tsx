import { NavLink, Outlet } from 'react-router-dom';
import { api } from '@client/lib/api';
import {
  LayoutDashboard,
  GitBranch,
  BarChart2,
  HeartPulse,
  LogOut,
  Bot,
} from 'lucide-react';
import { cn } from '@client/lib/utils';
import { Button } from '@client/components/ui/button';

const links = [
  { to: '/', label: 'Jobs', end: true, icon: LayoutDashboard },
  { to: '/repos', label: 'Repos', icon: GitBranch },
  { to: '/stats', label: 'Stats', icon: BarChart2 },
  { to: '/health', label: 'System', icon: HeartPulse },
];

export function AppShell() {
  return (
    <div className="flex min-h-svh bg-background">
      {/* ── Sidebar ── */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-[var(--sidebar-width)] flex-col gap-6 border-r border-border/50 px-4 py-6',
          'bg-card/70 backdrop-blur-xl shadow-[1px_0_0_0_hsl(var(--border)/40%)]',
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Bot size={16} />
          </div>
          <div>
            <div className="font-mono text-lg font-bold leading-none tracking-tight text-foreground">
              Codra
            </div>
            <div className="text-[10px] text-muted-foreground">PR Review Bot</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, end, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={16}
                    className={cn(
                      'shrink-0 transition-colors',
                      isActive ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Logout */}
        <Button
          variant="ghost"
          size="sm"
          className="justify-start gap-3 text-muted-foreground hover:text-foreground"
          onClick={async () => {
            await api.logout();
            location.href = '/login';
          }}
        >
          <LogOut size={15} />
          Log out
        </Button>
      </aside>

      {/* ── Main content ── */}
      <main className="ml-[var(--sidebar-width)] flex-1 min-w-0 px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
