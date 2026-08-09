import { useState, useEffect, useCallback } from "react";
import heroImage from "../../img/litria1.webp";

export default function SplashScreen({ onComplete }) {
  const [phase, setPhase] = useState("fade-in");

  useEffect(() => {
    const fadeInTimer = setTimeout(() => setPhase("visible"), 50);
    const holdTimer = setTimeout(() => setPhase("fade-out"), 3000);
    const doneTimer = setTimeout(() => onComplete(), 3600);

    return () => {
      clearTimeout(fadeInTimer);
      clearTimeout(holdTimer);
      clearTimeout(doneTimer);
    };
  }, [onComplete]);

  return (
    <div
      className={`splash-overlay ${phase === "fade-out" ? "splash-fade-out" : ""}`}
    >
      <div className="splash-image-wrap">
        <img
          src={heroImage}
          alt="Litria"
          className={`splash-image ${phase !== "fade-in" ? "splash-image-visible" : ""}`}
        />
      </div>
    </div>
  );
}
