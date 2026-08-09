import { buildIssueUrl } from './crashDomain.js';
import { invokeSafe } from './invoke.js';

// Next-launch notice (hard crashes / unclean shutdowns). Inline banner, not
// a modal — per the standing no-questionnaire-modal rule. Rendered by
// LaunchScreen when the startup scan returns unseen crash records.

function layerLabel(layer) {
  switch (layer) {
    case 'unclean-shutdown': return 'did not shut down cleanly';
    case 'webview': return 'interface process failed';
    case 'rust': return 'backend crashed';
    case 'react':
    case 'js': return 'interface crashed';
    default: return 'closed unexpectedly';
  }
}

function CrashNoticeBanner({ notices = [], onDismissed }) {
  if (!notices.length) return null;
  // Lead with the newest; the rest are summarized by count.
  const latest = notices[0];

  const handleViewLog = () => {
    invokeSafe('crash_open_logs_dir');
  };

  const handleReport = async () => {
    const record = {
      layer: latest.layer,
      timestamp: latest.timestamp,
      litriaVersion: latest.litriaVersion,
      os: latest.os,
      error: { message: latest.message },
      breadcrumbs: []
    };
    // Scrub-at-report boundary: no usernames/paths in the public issue body.
    const home = (await invokeSafe('crash_home_dir')) ?? '';
    const url = buildIssueUrl({ record, filePath: latest.path, home });
    invokeSafe('crash_open_report_url', { url });
  };

  const handleDismiss = async () => {
    await invokeSafe('crash_mark_seen', { fileNames: notices.map((n) => n.fileName) });
    if (typeof onDismissed === 'function') onDismissed();
  };

  return (
    <div className="crash-banner" role="status">
      <div className="crash-banner-text">
        <span className="crash-banner-lead">
          Litria {layerLabel(latest.layer)} last time.
        </span>
        {latest.message && <span className="crash-banner-msg"> {latest.message}</span>}
        {notices.length > 1 && (
          <span className="crash-banner-more"> (+{notices.length - 1} more)</span>
        )}
      </div>
      <div className="crash-banner-actions">
        <button type="button" className="crash-btn" onClick={handleViewLog}>View log</button>
        <button type="button" className="crash-btn" onClick={handleReport}>Report</button>
        <button type="button" className="crash-btn" onClick={handleDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

export default CrashNoticeBanner;
