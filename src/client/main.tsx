import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/Login';
import { JobsPage } from './pages/Jobs';
import { JobDetailPage } from './pages/JobDetail';
import { ReposPage } from './pages/Repos';
import { StatsPage } from './pages/Stats';
import './app.css';

const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <JobsPage /> },
      { path: 'jobs/:id', element: <JobDetailPage /> },
      { path: 'repos', element: <ReposPage /> },
      { path: 'stats', element: <StatsPage /> },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
