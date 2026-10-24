'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '../../components/Shell';
import { useAuth } from '../../lib/useAuth';
import { api } from '../../lib/api';
import { shortHash } from '../../lib/web3';

const fmtMs = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

export default function Ledger() {
  const user = useAuth();
  const [summary, setSummary] = useState(null);
  const [batches, setBatches] = useState([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([api('/api/ledger/summary'), api('/api/ledger/batches?limit=30')]);
      setSummary(s); setBatches(b); setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [user, load]);

  async function seal() {
    setBusy(true); setNote(''); setError('');
    try {
      const r = await api('/api/ledger/seal', { method: 'POST' });
      setNote(r.sealed_batch_id ? `Sealed batch #${r.sealed_batch_id}.` : 'Nothing to seal: no new device readings.');
      if (r.anchor_error) setError(`Anchoring failed: ${r.anchor_error}`);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const cards = summary ? [
    ['Device readings in ledger', summary.ledgered_readings],
    ['Signed by device key', summary.attested_readings],
    ['Waiting to be sealed', summary.pending_readings],
    ['Sealed batches', summary.batches],
    ['Anchored on chain', summary.anchored_batches],
  ] : [];

  return (
    <Shell user={user}>
      <div className="row">
        <div><h1>Verifiable data ledger</h1>
          <div className="muted small">Device readings are hashed into a Merkle tree, signed, and (optionally) anchored on an EVM chain. Simulated data is never ledgered.</div></div>
        {user?.role === 'master_admin' ? <button disabled={busy} onClick={seal}>{busy ? 'Sealing…' : 'Seal now'}</button> : null}
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {note ? <div className="small" style={{ color: '#5fe08a', marginTop: 8 }}>{note}</div> : null}

      <div className="grid g4" style={{ margin: '16px 0' }}>
        {cards.map(([l, v]) => <div key={l} className="card stat"><div className="n">{v}</div><div className="l">{l}</div></div>)}
      </div>

      {summary ? (
        <div className="card small" style={{ marginBottom: 16 }}>
          <div><b>Checkpoint signing key</b> <span className="muted">(Ed25519)</span></div>
          <div className="mono">{summary.server_key.did}</div>
          <div style={{ marginTop: 8 }}><b>On-chain anchoring:</b> {summary.anchoring_enabled
            ? <>enabled · contract <span className="mono">{summary.anchor?.contract}</span></>
            : <span className="muted">not configured: batches are sealed and signed, but not yet written to a chain</span>}</div>
          <div className="muted" style={{ marginTop: 4 }}>Sealing runs every {summary.seal_interval_secs}s. To verify any reading yourself, open a hardware room and press “Verify”, or run <span className="mono">node tools/verify_proof.mjs</span>.</div>
        </div>
      ) : null}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Batch</th><th>Readings</th><th>From</th><th>To</th><th>Merkle root</th><th>Status</th><th>Anchor transaction</th></tr></thead>
          <tbody>
            {batches.length === 0 ? <tr><td colSpan={7} className="muted">No batches yet. Connect a device (or run <span className="mono">tools/sim_device.mjs</span>), then seal.</td></tr> : batches.map((b) => (
              <tr key={b.id}>
                <td>#{b.id}</td><td>{b.leaf_count}</td><td>{fmtMs(b.from_ms)}</td><td>{fmtMs(b.to_ms)}</td>
                <td className="mono" title={b.root}>{shortHash(b.root, 6)}</td>
                <td><span className={`tag ${b.status === 'anchored' ? 'hw' : 'sim'}`}>{b.status.toUpperCase()}</span></td>
                <td className="mono" title={b.anchor?.tx_hash || ''}>{b.anchor ? `${shortHash(b.anchor.tx_hash, 6)} · block ${b.anchor.block_number}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
