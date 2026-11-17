import { NavLink, Route, Routes } from 'react-router-dom';
import { Browse } from './pages/Browse.js';
import { Dashboard } from './pages/Dashboard.js';
import { Logs } from './pages/Logs.js';
import { Movie } from './pages/Movie.js';
import { Review } from './pages/Review.js';
import { Unresolved } from './pages/Unresolved.js';
import { DeadLinks } from './pages/DeadLinks.js';
import { Coverage } from './pages/Coverage.js';
import { Show } from './pages/Show.js';
import { Rules } from './pages/Rules.js';
import { Settings } from './pages/Settings.js';
import { Title } from './pages/Title.js';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/browse', label: 'Browse' },
  { to: '/review', label: 'Review' },
  { to: '/unresolved', label: 'Unresolved' },
  { to: '/dead', label: 'Dead links' },
  { to: '/coverage', label: 'Coverage' },
  { to: '/rules', label: 'Rules' },
  { to: '/settings', label: 'Settings' },
  { to: '/logs', label: 'Logs' },
];

export function App() {
  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-800 bg-neutral-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
          <span className="font-semibold tracking-tight">
            Tamil<span className="text-amber-400">Cache</span>
          </span>
          <nav className="flex gap-1 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `rounded px-3 py-1.5 transition ${
                    isActive ? 'bg-neutral-800 text-neutral-50' : 'text-neutral-400 hover:text-neutral-100'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/title/:key" element={<Title />} />
          <Route path="/movie/:mediaId" element={<Movie />} />
          <Route path="/show/:mediaId" element={<Show />} />
          <Route path="/review" element={<Review />} />
          <Route path="/unresolved" element={<Unresolved />} />
          <Route path="/dead" element={<DeadLinks />} />
          <Route path="/coverage" element={<Coverage />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </main>
    </div>
  );
}
