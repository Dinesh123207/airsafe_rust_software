'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, saveSession } from '../../lib/api';
import { walletAuth } from '../../lib/web3';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      saveSession(await api('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }));
      router.push('/master-admin');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function wallet() {
    setBusy(true); setError('');
    try {
      saveSession(await walletAuth());
      router.push('/master-admin');
    } catch (err) {
      setError(err.status === 404 ? 'No account for this wallet yet. Use "Register" to create one.' : (err.message || 'Wallet sign-in failed'));
    } finally { setBusy(false); }
  }

  return (
    <div className="auth card">
      <h1>AIRSAFE</h1>
      <p className="muted small">Sign in to the monitoring console</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div style={{ marginTop: 16 }}><button disabled={busy} type="submit">{busy ? 'Working…' : 'Sign in'}</button></div>
      </form>
      <div className="or"><span>or</span></div>
      <button className="ghost wide" disabled={busy} type="button" onClick={wallet}>Sign in with Ethereum</button>
      <p className="muted small" style={{ marginTop: 8 }}>Your wallet signs a free message. No transaction, no fee.</p>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <p className="muted small" style={{ marginTop: 16 }}>No account? <Link href="/register">Register</Link></p>
    </div>
  );
}
