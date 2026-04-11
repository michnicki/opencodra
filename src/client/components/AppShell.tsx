import { NavLink, Outlet } from 'react-router-dom';
import { api } from '@client/lib/api';

const links = [
  { to: '/', label: 'Jobs', end: true },
  { to: '/repos', label: 'Repos' },
  { to: '/stats', label: 'Stats' },
];

export function AppShell() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand">Codra</div>
          <p className="muted">Private PR review operations dashboard.</p>
        </div>

        <nav className="nav">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <button
          className="ghost-button"
          type="button"
          onClick={async () => {
            await api.logout();
            location.href = '/login';
          }}
        >
          Log out
        </button>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
