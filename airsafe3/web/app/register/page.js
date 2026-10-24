'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, saveSession } from '../../lib/api';
import { walletAuth } from '../../lib/web3';

export default function Register() {
  const router = useRouter();
  const [f, setF] = useState({ email: '', password: '', role: 'master_admin', vertical_access: 'all' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      saveSession(await api('/api/auth/register', { method: 'POST', body: f, auth: false }));
      router.push('/master-admin');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function wallet() {
    setBusy(true); setError('');
    try {
      saveSession(await walletAuth({ role: f.role, vertical_access: f.vertical_access }));
      router.push('/master-admin');
    } catch (err) { setError(err.message || 'Wallet registration failed'); } finally { setBusy(false); }
  }

  return (
    <div className="auth card">
      <h1>Create account</h1>
      <p className="muted small">Prototype: anyone can self-register as master admin. Lock this down before going public.</p>
      <form onSubmit={submit}>
        <label htmlFor="role">Role</label>
        <select id="role" value={f.role} onChange={set('role')}>
          <option value="master_admin">Master admin</option>
          <option value="property_admin">Property admin</option>
          <option value="staff">Staff</option>
        </select>
        <label htmlFor="vertical">Vertical access</label>
        <select id="vertical" value={f.vertical_access} onChange={set('vertical_access')}>
          <option value="all">All verticals</option>
          <option value="hospital">Hospital</option>
          <option value="hotel">Hotel</option>
          <option value="corporate">Corporate</option>
        </select>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={f.email} onChange={set('email')} />
        <label htmlFor="password">Password (8+ characters)</label>
        <input id="password" type="password" minLength={8} value={f.password} onChange={set('password')} />
        <div style={{ marginTop: 16 }}><button disabled={busy} type="submit">{busy ? 'Working…' : 'Create account with email'}</button></div>
      </form>
      <div className="or"><span>or</span></div>
      <button className="ghost wide" disabled={busy} type="button" onClick={wallet}>Register with Ethereum wallet</button>
      <p className="muted small" style={{ marginTop: 8 }}>Uses the role and vertical chosen above. The wallet only signs a free message.</p>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <p className="muted small" style={{ marginTop: 16 }}>Already registered? <Link href="/login">Sign in</Link></p>
    </div>
  );
}
