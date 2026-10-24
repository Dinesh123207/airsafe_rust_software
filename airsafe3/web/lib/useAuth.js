'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getUser } from './api';

// Redirects to /login when there is no token; returns the stored user once known.
export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    setUser(getUser());
  }, [router]);
  return user;
}
