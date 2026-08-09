function ProjectBar({ leading, zoomLevel, children }) {
  return (
    <div className="project-bar">
      <span className="project-bar-lead">{leading}</span>
      <span className="project-bar-end">
        {zoomLevel != null && (
          <span className="project-bar-zoom">{zoomLevel}%</span>
        )}
        {children}
      </span>
    </div>
  );
}

export default ProjectBar;
