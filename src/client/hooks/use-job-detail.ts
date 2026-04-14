import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@client/lib/api';
import type { JobDetail } from '@shared/schema';

export function useJobDetail(id: string) {
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const pollInterval = useRef<number | null>(null);

  const fetchJob = async (silent = false) => {
    try {
      const response = await api.getJob(id);
      setJob(response.job);
      setError(null);
      if (response.job.status === 'done' || response.job.status === 'failed') stopPolling();
    } catch (loadError) {
      if (!silent) setError(loadError instanceof Error ? loadError.message : 'Failed to load job.');
    }
  };

  const startPolling = () => {
    if (pollInterval.current) return;
    pollInterval.current = window.setInterval(() => fetchJob(true), 3000);
  };

  const stopPolling = () => {
    if (pollInterval.current) {
      window.clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
  };

  useEffect(() => {
    if (id) {
      fetchJob();
    }
    return () => stopPolling();
  }, [id]);

  useEffect(() => {
    if (job && (job.status === 'queued' || job.status === 'running')) {
      startPolling();
    } else {
      stopPolling();
    }
  }, [job?.status]);

  const handleRetry = async () => {
    if (!job) return;
    setIsRetrying(true);
    try {
      const response = await api.retryJob(job.id);
      navigate(`/jobs/${response.job.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to retry job.');
    } finally {
      setIsRetrying(false);
    }
  };

  return {
    job,
    error,
    isRetrying,
    handleRetry,
    fetchJob
  };
}
