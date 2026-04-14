import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { JobsPage } from './pages/jobs';
import { JobDetailPage } from './pages/job-detail';
import { ReposPage } from './pages/repos';
import { StatsPage } from './pages/stats';
import { HealthPage } from './pages/health';
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
      { path: 'health', element: <HealthPage /> },
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
