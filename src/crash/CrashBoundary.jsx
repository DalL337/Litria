import { Component } from 'react';
import { getLastCrash } from './errorCapture.js';
import { buildIssueUrl } from './crashDomain.js';
import { invokeSafe } from './invoke.js';

// Top-level error boundary (hook #1). Sits ABOVE the theme providers on
// purpose: coverage beats theming — most of Litria's logic lives in App's
// hooks, and a boundary inside App couldn't catch them. The fallback is
// therefore self-styled (see crash.css). Logging is centralized in the
// React 19 root options (onCaughtError fires for boundary-caught errors);
// this component owns fallback UI only.

class CrashBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  handleReload = () => {
    window.location.reload();
  };

  handleViewLogs = () => {
    invokeSafe('crash_open_logs_dir');
  };

  handleReport = async () => {
    const { record, path } = getLastCrash();
    const fallbackRecord = record ?? {
      layer: 'react',
      error: { message: this.state.error?.message ?? 'render crash' },
      breadcrumbs: []
    };
    // Scrub-at-report boundary: usernames/paths must not leak into a public
    // issue. Home replacement also covers project roots under the profile.
    const home = (await invokeSafe('crash_home_dir')) ?? '';
    const url = buildIssueUrl({ record: fallbackRecord, filePath: path ?? '', home });
    invokeSafe('crash_open_report_url', { url });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const message = this.state.error?.message ?? 'Unknown render error';
    return (
      <div className="crash-fallback" role="alert">
        <div className="crash-fallback-panel">
          <div className="crash-fallback-title">Litria hit a wall.</div>
          <div className="crash-fallback-sub">
            The interface crashed while rendering and a crash log was saved locally.
            Files already saved to disk are safe; unsaved editor changes from this
            session may be lost when you reload.
          </div>
          <div className="crash-fallback-error">{message}</div>
          <div className="crash-fallback-actions">
            <button type="button" className="crash-btn crash-btn-primary" onClick={this.handleReload}>
              Reload Litria
            </button>
            <button type="button" className="crash-btn" onClick={this.handleViewLogs}>
              View Logs
            </button>
            <button type="button" className="crash-btn" onClick={this.handleReport}>
              Report
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default CrashBoundary;
