'use client';
import { useEffect, useMemo, useState } from 'react';
import { Topbar, KpiStrip, FilterSidebar, FeedPanel } from './Primitives';
import { HospitalCard, HotelCard, ZoneCard } from './cards';
import RoomDrawer from './RoomDrawer';
import {
  VERTICAL_CONFIG, spectrum, spectrumIaq, toIaq, iaqLabel, filterOptions, tierGroups, hotelIssue,
  hospitalKpis, hotelKpis, corporateKpis, ago,
} from '../../lib/risk.mjs';

const CARD = { hospital: HospitalCard, hotel: HotelCard, corporate: ZoneCard };

function kpiItems(vertical, rooms, alerts) {
  if (vertical === 'hospital') {
    const k = hospitalKpis(rooms, alerts);
    return [
      { label: 'Transmission Risk Index', value: k.index, unit: '/ 100', color: k.index === null ? null : spectrum(k.index) },
      { label: 'Zones Requiring Attention', value: k.attention, unit: 'zones', sub: 'risk index of 60 or more' },
      { label: 'Active Environmental Alerts', value: k.alerts },
      { label: 'Ventilation Status', value: k.ventilation, unit: '%', sub: 'rooms at 10+ ACH (estimated)' },
    ];
  }
  if (vertical === 'hotel') {
    const k = hotelKpis(rooms);
    return [
      { label: 'Property IAQ Score', value: k.iaq, unit: '/ 100', color: k.iaq === null ? null : spectrumIaq(k.iaq) },
      { label: 'Rooms Requiring Attention', value: k.attention, sub: 'IAQ score below 65' },
      { label: 'Occupied Rooms', value: k.occupied, unit: `of ${rooms.length}` },
      { label: 'Active Alerts', value: k.tasks },
    ];
  }
  const k = corporateKpis(rooms);
  return [
    { label: 'Workplace Environmental Score', value: k.iaq, unit: '/ 100', color: k.iaq === null ? null : spectrumIaq(k.iaq) },
    { label: 'Space Utilization', value: k.utilization, unit: '%' },
    { label: 'Meeting No-Shows', value: k.noShows, unit: 'now', color: k.noShows ? 'var(--bad)' : null, sub: 'booked rooms with nobody inside' },
    { label: 'IAQ Reference Status', value: k.reference, unit: '%', sub: 'zones under 800 ppm CO₂' },
  ];
}

function feedItems(vertical, rooms, alerts) {
  if (vertical === 'hotel') {
    return rooms
      .filter((r) => r.score !== null && hotelIssue(r))
      .sort((a, b) => b.score - a.score)
      .map((r) => {
        const iaq = toIaq(r.score);
        return {
          key: r.id, roomId: r.id, accent: spectrumIaq(iaq), top: iaqLabel(iaq),
          title: r.name, detail: hotelIssue(r), rec: `${r.department} · ${(r.occupancy ?? 0) > 0 ? 'Occupied' : 'Vacant'}`,
        };
      });
  }
  return alerts.map((a) => ({
    key: a.room_id, roomId: a.room_id, accent: spectrum(a.score),
    top: vertical === 'corporate'
      ? (a.status === 'No-Show' ? 'MEETING NO-SHOW' : iaqLabel(toIaq(a.score)).toUpperCase())
      : `${a.status} · Score ${Math.round(a.score)}`,
    title: a.room_name, detail: a.detail, rec: a.recommendation ? `Suggested: ${a.recommendation}` : '',
  }));
}

export default function DashboardView({ vertical, rooms, alerts, loading, error, updatedAt, user, onLogout }) {
  const cfg = VERTICAL_CONFIG[vertical];
  const Card = CARD[vertical];
  const [filter, setFilter] = useState('All');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => { setFilter('All'); setSelectedId(null); }, [vertical]);

  const options = useMemo(() => filterOptions(rooms, cfg.filterKey), [rooms, cfg.filterKey]);
  const visible = filter === 'All' ? rooms : rooms.filter((r) => r[cfg.filterKey] === filter);
  const groups = useMemo(() => tierGroups(visible, cfg.tierOrder), [visible, cfg.tierOrder]);
  const selected = rooms.find((r) => r.id === selectedId) || null;
  const colorFor = vertical === 'hospital' ? spectrum : (risk) => spectrumIaq(toIaq(risk));
  const offline = Boolean(error) && rooms.length > 0;

  return (
    <div className="dash-root" data-theme={cfg.theme}>
      <Topbar config={cfg} rooms={rooms} offline={offline} user={user} onLogout={onLogout} />
      {error ? (
        <div className="dash-banner" role="alert">
          {rooms.length ? `Connection problem: showing data from ${ago(updatedAt)}.` : 'Cannot load data.'} <span>{error}</span>
        </div>
      ) : null}
      <KpiStrip items={kpiItems(vertical, rooms, alerts)} />
      <div className="dash-grid">
        <FilterSidebar title={cfg.filterTitle} options={options} active={filter} onSelect={setFilter} colorFor={colorFor} />
        <div className="dash-main">
          {loading && rooms.length === 0 ? <div className="dash-empty">Loading rooms…</div> : null}
          {!loading && rooms.length === 0 && !error ? <div className="dash-empty">No rooms found for this vertical.</div> : null}
          {groups.map((g) => (
            <section className="tier" key={g.tier}>
              <div className="tier-head">
                <span className="tier-title">{g.tier}</span>
                <span className="tier-note">{[cfg.tierNote[g.tier], `${g.rooms.length} ${vertical === 'hotel' ? 'rooms' : 'zones'}`].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="card-grid">
                {g.rooms.map((r) => <Card key={r.id} room={r} onOpen={setSelectedId} />)}
              </div>
            </section>
          ))}
          <footer className="dash-foot">{cfg.footnote}</footer>
        </div>
        <FeedPanel title={cfg.feedTitle} sub={cfg.feedSub} items={feedItems(vertical, rooms, alerts)}
          emptyText="Nothing currently above the alert threshold." onOpen={setSelectedId} />
      </div>
      {selected ? <RoomDrawer room={selected} vertical={vertical} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
