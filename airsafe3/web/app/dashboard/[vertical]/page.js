import DashboardClient from './DashboardClient';

// The exported (static) build needs the three verticals listed up front.
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ vertical: 'hospital' }, { vertical: 'hotel' }, { vertical: 'corporate' }];
}

export default function DashboardPage() {
  return <DashboardClient />;
}
