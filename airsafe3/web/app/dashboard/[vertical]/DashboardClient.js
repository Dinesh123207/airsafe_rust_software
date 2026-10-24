'use client';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardView from '../../../components/dash/DashboardView';
import Shell from '../../../components/Shell';
import { useAuth } from '../../../lib/useAuth';
import { useVerticalData } from '../../../lib/useVerticalData';
import { clearSession } from '../../../lib/api';
import { VERTICAL_CONFIG } from '../../../lib/risk.mjs';
import '../dashboard.css';

export default function DashboardClient() {
  const { vertical } = useParams();
  const router = useRouter();
  const user = useAuth();
  const known = Boolean(VERTICAL_CONFIG[vertical]);
  const data = useVerticalData(user && known ? vertical : null);

  if (!known) {
    return (
      <Shell user={user}>
        <h1>Unknown vertical</h1>
        <p className="muted">Try <Link href="/dashboard/hospital">hospital</Link>, <Link href="/dashboard/hotel">hotel</Link> or <Link href="/dashboard/corporate">corporate</Link>.</p>
      </Shell>
    );
  }
  if (!user) return null;
  return (
    <DashboardView vertical={vertical} user={user} {...data}
      onLogout={() => { clearSession(); router.push('/login'); }} />
  );
}
