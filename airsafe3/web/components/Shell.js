'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearSession } from '../lib/api';

export default function Shell({ user, children, back }) {
  const router = useRouter();
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">AIRSAFE</div>
        <nav>
          {back ? <Link href={back.href}>{back.label}</Link> : null}
          <Link href="/master-admin">Overview</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/ledger">Ledger</Link>
          <span className="who">{user ? `${user.email} · ${user.role}` : ''}</span>
          <button className="ghost" onClick={() => { clearSession(); router.push('/login'); }}>Log out</button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
