'use client';
import { useEffect, useId, useState } from 'react';
import { ChevronDown, Radio } from 'lucide-react';
import type { CaptureHealth } from './types';

const historyLabels: Record<string, string> = { unknown: 'Coverage not verified', not_applicable: 'Not applicable', gaps_detected: 'Gaps detected', no_known_gaps: 'No gaps reported' };

const labels: Record<string, string> = { reporting: 'Reporting', catching_up: 'Catching up', not_reporting: 'Not reporting', ended: 'Stream ended', unknown: 'Status unavailable', not_applicable: 'No sandbox recording', gaps_detected: 'Gaps detected', no_known_gaps: 'No gaps reported' };

export function CaptureHealthStatus({ health }: { health?: CaptureHealth }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const live = (health?.live === 'reporting' || health?.live === 'catching_up') && health.lastHeartbeatAt != null && now - health.lastHeartbeatAt > 15000 ? 'not_reporting' : health?.live ?? 'unknown';
  const missingMetadata = live === 'unknown' && health?.lastHeartbeatAt == null && health?.capabilities == null;
  const history = historyLabels[health?.history ?? 'unknown'];
  const disconnect = health?.issues.find(issue => issue.reason === 'collector_disconnected');
  const warning = live === 'not_reporting' || health?.history === 'gaps_detected' || !!health?.issues.length;
  const tone = warning ? 'warning' : live === 'reporting' ? 'live' : 'quiet';

  return <div className="capture-health">
    <div className="rt-capture-summary">
      <button type="button" className="rt-capture-capsule" data-tone={tone}
        aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
        <span className="rt-capture-dot" aria-hidden="true" />
        <span>{live === 'unknown' ? <strong>Recording status unavailable</strong> : <>Recording <span className="rt-capture-divider">/</span> <strong>{labels[live]}</strong></>}</span>
        <ChevronDown size={13} className="rt-capture-chevron" aria-hidden="true" />
      </button>
      <span className="rt-capture-history" role="status">{history}</span>
    </div>
    <small className="rt-capture-caveat">{missingMetadata ? 'Recorder health metadata is unavailable for this capture.' : 'Selected recorded events; completeness is not certified.'}</small>
    <div className="rt-capture-drawer" data-open={expanded} id={detailsId} inert={!expanded}>
      <div><div className="rt-capture-details">
        <span><Radio size={14} aria-hidden="true" /> {live === 'unknown' ? 'Live recorder status cannot be verified.' : `Current stream: ${labels[live]}.`} Coverage: {history.toLowerCase()}.</span>
        {missingMetadata && <p className="rt-capture-explanation">This capture has no recorder heartbeat or coverage metadata available to verify recording health. This does not mean no commands were recorded. Captured commands and events can still be inspected under Sandbox evidence.</p>}
        <small>Recording health covers selected events; it does not certify completeness.</small>
        {health?.lastHeartbeatAt != null && <small>Last heartbeat: {new Date(health.lastHeartbeatAt).toLocaleTimeString()}</small>}
        {!!health?.issues.length && <details><summary>Recording issues ({health.issues.length})</summary><ul>{health.issues.map((issue, i) => <li key={i}>{issue.reason} · {new Date(issue.at).toLocaleString()}</li>)}</ul></details>}
      </div></div>
    </div>
    <span className="rt-sr-only" role="status">Recording: {labels[live]}</span>
    {disconnect && <p className="rt-capture-warning">Recorder disconnected at {new Date(disconnect.at).toLocaleTimeString()} during this run. Commands may be missing from the recording.</p>}
    {health?.capabilities && (!health.capabilities.files || !health.capabilities.network) && <p className="rt-capture-warning">File or network recording is unavailable for part of this capture.</p>}
    {!!health?.issues.length && !disconnect && <p className="rt-capture-warning">{health.issues.length} recording issue{health.issues.length === 1 ? '' : 's'} reported. Expand recording details to inspect.</p>}
  </div>;
}
