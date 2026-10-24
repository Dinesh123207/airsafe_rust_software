'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

// Polls rooms + alerts for one vertical. Keeps the last good data when a poll fails and says so,
// instead of blanking the dashboard on a network blip.
export function useVerticalData(vertical, intervalMs = 5000) {
  const [state, setState] = useState({ rooms: [], alerts: [], loading: true, error: '', updatedAt: null });

  useEffect(() => {
    if (!vertical) return undefined;
    let alive = true;
    let timer = null;
    setState({ rooms: [], alerts: [], loading: true, error: '', updatedAt: null });

    const load = async () => {
      try {
        const [rooms, alerts] = await Promise.all([
          api(`/api/rooms?vertical=${encodeURIComponent(vertical)}`),
          api(`/api/alerts?vertical=${encodeURIComponent(vertical)}`),
        ]);
        if (alive) setState({ rooms, alerts, loading: false, error: '', updatedAt: new Date().toISOString() });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, loading: false, error: e.message || 'Request failed' }));
      } finally {
        if (alive) timer = setTimeout(load, intervalMs);
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [vertical, intervalMs]);

  return state;
}
